import { Bot } from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';
import { config } from './config.ts';
import { errorFields, log } from './log.ts';
import { botToken } from './secrets.ts';
import type { ImageMediaType, ReceiptImage } from './vision.ts';

/** Telegram's getFile ceiling. Anything larger can't be downloaded at all. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Budget for the getMe call. Well inside the api Lambda's 15s timeout so the
 * failure is logged rather than swallowed by the runtime killing the process.
 */
const INIT_TIMEOUT_MS = 6000;

/** Above this, a Telegram call is eating the webhook's ~3s budget. */
const SLOW_API_CALL_MS = 1500;

export interface ImageRef {
  fileId: string;
  mediaType: ImageMediaType;
}

/**
 * Picks the image out of a message.
 *
 * `message.photo` is an array of sizes — we take the LAST element, which is the
 * largest. We also accept image documents: long receipts get badly compressed
 * as photos, and sending as a file preserves the small print.
 */
export function imageFrom(message: Message): ImageRef | null {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    // Telegram re-encodes photos to JPEG regardless of what was uploaded.
    return { fileId: largest.file_id, mediaType: 'image/jpeg' };
  }

  const doc = message.document;
  if (doc) {
    const mediaType = normaliseMediaType(doc.mime_type);
    if (mediaType) return { fileId: doc.file_id, mediaType };
  }

  return null;
}

function normaliseMediaType(mime: string | undefined): ImageMediaType | null {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'image/jpeg';
    case 'image/png':
      return 'image/png';
    case 'image/webp':
      return 'image/webp';
    case 'image/gif':
      return 'image/gif';
    default:
      return null;
  }
}

/**
 * Calls getMe with plain fetch, so failures report the actual cause.
 *
 * `fetch` wraps transport-level problems (DNS, TLS, connection refused) in a
 * generic TypeError whose `cause` holds the real error — logging the message
 * alone tells you nothing, which is why `cause` is unpacked here.
 */
async function fetchBotInfo(token: string): Promise<UserFromGetMe> {
  const started = Date.now();
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
    });
    const body = (await response.json()) as { ok: boolean; result?: UserFromGetMe; description?: string };

    if (!response.ok || !body.ok || !body.result) {
      // A real HTTP answer means the network is fine and Telegram rejected us —
      // a very different problem from not reaching Telegram at all.
      log.error('getMe rejected by telegram', {
        status: response.status,
        description: body.description,
        ms: Date.now() - started,
      });
      throw new Error(`getMe returned ${response.status}: ${body.description ?? 'unknown'}`);
    }

    return body.result;
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as Error | undefined) : undefined;
    log.error('getMe transport failure', {
      ms: Date.now() - started,
      err: err instanceof Error ? err.message : String(err),
      errName: err instanceof Error ? err.name : undefined,
      // The bit that actually identifies the problem: ENOTFOUND, ECONNREFUSED,
      // UND_ERR_CONNECT_TIMEOUT, a TLS failure, and so on.
      cause: cause?.message,
      causeName: cause?.name,
      causeCode: (cause as NodeJS.ErrnoException | undefined)?.code,
    });
    throw err;
  }
}

/**
 * Logs the outcome of every Telegram API call.
 *
 * This exists because a broken HTTP client once looked like an unexplained
 * Lambda timeout: replies were failing, but nothing recorded that a call had
 * even been attempted. One line per call makes "Telegram refused us", "Telegram
 * is slow", and "the request never left the process" three visibly different
 * failures.
 *
 * The payload is deliberately never logged — it holds message text and item
 * names, which do not belong in CloudWatch.
 */
function instrumentApiCalls(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const started = Date.now();
    try {
      const result = await prev(method, payload, signal);
      const ms = Date.now() - started;

      if (!result.ok) {
        // Telegram answered and said no: bad request, blocked by user, etc.
        log.warn('telegram api rejected', {
          method,
          ms,
          errorCode: result.error_code,
          description: result.description,
        });
      } else if (ms > SLOW_API_CALL_MS) {
        log.warn('telegram api slow', { method, ms });
      } else {
        log.info('telegram api ok', { method, ms });
      }
      return result;
    } catch (err) {
      // Never reached Telegram at all — transport died, or we aborted.
      log.error('telegram api transport failed', {
        method,
        ms: Date.now() - started,
        ...errorFields(err),
      });
      throw err;
    }
  });
}

let botPromise: Promise<Bot> | null = null;

/**
 * Memoised, ready-to-use Bot — one getMe per container, not per invocation.
 *
 * botInfo is fetched live rather than pinned in an env var, so it cannot drift
 * from the real bot profile, but it is passed to the constructor so grammY
 * never calls init() itself. See fetchBotInfo for why we don't let grammY make
 * that request.
 */
export function getBot(build?: (bot: Bot) => void): Promise<Bot> {
  if (!botPromise) {
    botPromise = (async () => {
      const t0 = Date.now();
      const token = await botToken();
      const tokenMs = Date.now() - t0;

      // We fetch getMe ourselves rather than calling bot.init(). Two reasons:
      //
      // 1. grammY retries failed API calls with a backoff sleep, so the real
      //    network error never surfaces — you just get "Aborted delay" once
      //    something cancels the sleep, which says nothing about the cause.
      // 2. Passing botInfo to the constructor skips init() entirely, removing a
      //    Telegram round-trip from the webhook path. Telegram only waits ~3s
      //    before retrying the update, so that round-trip is worth deleting.
      let botInfo: UserFromGetMe;
      try {
        botInfo = await fetchBotInfo(token);
      } catch (err) {
        botPromise = null; // don't memoise a rejection for the container's life
        throw err;
      }

      const bot = new Bot(token, {
        botInfo,
        client: {
          // grammY defaults to a bundled node-fetch shim, which fails instantly
          // in this Lambda ("Network request for 'sendMessage' failed!" in
          // ~20ms — far too fast to be a timeout) while native fetch reaches
          // Telegram from the same container in well under a second. So hand it
          // the platform fetch that demonstrably works here.
          fetch: globalThis.fetch,
          // baseFetchConfig defaults to node-fetch-only options — `agent` and
          // `compress` — which mean nothing to native fetch. `duplex` is kept:
          // it is standard and required when streaming a request body.
          baseFetchConfig: { duplex: 'half' },
        },
      });
      instrumentApiCalls(bot);
      build?.(bot);

      log.info('bot initialised', {
        tokenMs,
        initMs: Date.now() - t0 - tokenMs,
        username: bot.botInfo.username,
      });
      return bot;
    })();
  }
  return botPromise;
}

/**
 * Streams the image from Telegram straight into memory and returns it base64'd
 * for the vision call. The photo is never persisted — not to disk, not to S3.
 */
export async function downloadImage(bot: Bot, ref: ImageRef): Promise<ReceiptImage> {
  const file = await bot.api.getFile(ref.fileId);
  if (!file.file_path) throw new Error('telegram returned no file_path');
  if (file.file_size && file.file_size > MAX_FILE_BYTES) {
    throw new Error(`image too large: ${file.file_size} bytes`);
  }

  const url = `https://api.telegram.org/file/bot${await botToken()}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`file download failed: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new Error(`image too large: ${buffer.byteLength} bytes`);
  }

  // Trust the file extension over the declared mime for documents, since
  // clients lie about mime more often than about extensions.
  const fromPath = mediaTypeFromPath(file.file_path);
  return { data: buffer.toString('base64'), mediaType: fromPath ?? ref.mediaType };
}

function mediaTypeFromPath(path: string): ImageMediaType | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return null;
  }
}

/**
 * The published privacy policy.
 *
 * Served as a static file from the same CloudFront distribution as the Mini App
 * — the `.html` is load-bearing, because the distribution rewrites unknown
 * paths to index.html, so an extensionless `/privacy` would silently serve the
 * app instead of the policy.
 */
export function privacyUrl(): string {
  return `${config.miniAppUrl()}/privacy.html`;
}

/** Mini App launch URL. The bill id rides in the query string. */
export function miniAppUrl(billId: string): string {
  return `${config.miniAppUrl()}/?bill=${encodeURIComponent(billId)}`;
}
