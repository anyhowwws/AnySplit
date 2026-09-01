import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Structured JSON logging.
 *
 * Every line carries the ambient context — request id, update id, bill id — so
 * a CloudWatch Logs Insights filter on one `billId` reconstructs that bill's
 * whole life across both Lambdas. Passing those ids down by hand meant they
 * were missing from exactly the lines that mattered during an incident, so they
 * are attached automatically instead.
 *
 * PRIVACY: log structure, never content. No message text, no item names, no
 * image bytes. AnySplit promises receipts are never stored, and a log line is
 * storage.
 */

type Fields = Record<string, unknown>;

const context = new AsyncLocalStorage<Fields>();

/** Runs `fn` with `fields` attached to every log line it emits. */
export function withLogContext<T>(fields: Fields, fn: () => Promise<T>): Promise<T> {
  const parent = context.getStore() ?? {};
  return context.run({ ...parent, ...fields }, fn);
}

/**
 * Adds to the current context after the fact — for ids that only become known
 * partway through, like a billId minted mid-request.
 */
export function addLogContext(fields: Fields): void {
  const store = context.getStore();
  if (store) Object.assign(store, fields);
}

/**
 * Bot tokens appear inside Telegram API URLs, and HTTP client errors quote the
 * URL they failed on ("request to https://api.telegram.org/bot123:ABC.../send
 * Message failed"). Unwrapping error causes therefore risks writing the token
 * into CloudWatch, where it would outlive any rotation. Scrub every line.
 */
const TOKEN_IN_URL = /bot\d{6,}:[A-Za-z0-9_-]{30,}/g;

function redact(line: string): string {
  return line.replace(TOKEN_IN_URL, 'bot<redacted>');
}

function emit(level: 'info' | 'warn' | 'error', msg: string, fields: Fields = {}): void {
  const line = redact(
    JSON.stringify({
      level,
      msg,
      ts: new Date().toISOString(),
      ...context.getStore(),
      ...fields,
    }),
  );
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};

/**
 * True exactly once per container. Distinguishes "slow because cold" from
 * "slow because something is wrong" — worth knowing on a path with a 3s budget.
 */
let firstInvocation = true;

export function consumeColdStart(): boolean {
  const cold = firstInvocation;
  firstInvocation = false;
  return cold;
}

/**
 * Turns an unknown catch value into something loggable.
 *
 * Walks the wrapper chain as well as the top-level error. Libraries bury the
 * useful part: grammY reports "Network request for 'sendMessage' failed!" and
 * hangs the real reason off `.error`, while `fetch` reports a bare "fetch
 * failed" and hangs the real reason off `.cause`. Logging only the outer
 * message tells you something broke but never what — which is precisely how a
 * dead HTTP client masqueraded as a mystery timeout for an afternoon.
 */
export function errorFields(err: unknown): Fields {
  const fields: Fields = {};
  const chain: string[] = [];

  let current: unknown = err;
  for (let depth = 0; current != null && depth < 6; depth++) {
    if (!(current instanceof Error)) {
      chain.push(String(current));
      break;
    }

    const code = (current as NodeJS.ErrnoException).code;
    chain.push(`${current.name}: ${current.message}${code ? ` (${code})` : ''}`);

    if (depth === 0) {
      fields.err = current.message;
      fields.errName = current.name;
      fields.stack = current.stack;
    } else if (fields.rootCause === undefined) {
      fields.rootCause = current.message;
      fields.rootCauseName = current.name;
      if (code) fields.rootCauseCode = code;
    }

    // `cause` is the standard; `error` is grammY's convention.
    current = current.cause ?? (current as { error?: unknown }).error;
  }

  fields.chain = chain;
  return fields;
}
