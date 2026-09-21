import { Hono } from 'hono';
import type { Context } from 'hono';
import { handle } from 'hono/aws-lambda';
import type { Update } from 'grammy/types';
import type {
  Bill,
  FinaliseRequest,
  FinaliseResponse,
  GetBillResponse,
  PatchBillRequest,
  SendMode,
  Share,
  Unit,
} from '../../../shared/types.ts';
import { registerHandlers } from '../lib/bot.ts';
import { CalcError, computeShares, deriveFactor, subtotalOf, unassignedCents } from '../lib/calc.ts';
import { MAX_PEOPLE, MIN_PEOPLE } from '../lib/config.ts';
import { botToken, webhookSecret } from '../lib/secrets.ts';
import { claimUpdate, getBill, saveEdits, saveShares } from '../lib/db.ts';
import { consolidatedMessage, shareMessage } from '../lib/format.ts';
import { isBillId } from '../lib/ids.ts';
import { addLogContext, consumeColdStart, errorFields, log, withLogContext } from '../lib/log.ts';
import { formatMoney, isCents } from '../lib/money.ts';
import { isSupportedCurrency } from '../../../shared/currency.ts';
import { cleanPayee, toStoredPayee } from '../../../shared/payee.ts';
import { initDataFromAuthHeader, verifyInitData } from '../lib/initdata.ts';
import { getBot } from '../lib/telegram.ts';
import { userRef } from '../lib/userref.ts';

/** Telegram redelivers an update if we haven't acked within roughly this long. */
const TELEGRAM_ACK_BUDGET_MS = 2500;

const app = new Hono();

/* ---------------------------------------------------------------- webhook */

app.post('/webhook', async (c) => {
  // Without this check, anyone who discovers the API Gateway URL can inject
  // fake updates. The token is set when we call setWebhook.
  const provided = c.req.header('x-telegram-bot-api-secret-token');
  if (provided !== (await webhookSecret())) {
    log.warn('webhook rejected: bad secret token');
    return c.text('forbidden', 403);
  }

  let update: Update;
  try {
    update = (await c.req.json()) as Update;
  } catch {
    // Malformed body: 200 anyway, so Telegram doesn't retry something that can
    // never succeed.
    return c.text('ok', 200);
  }

  // Everything below shares one log context, so a filter on this updateId shows
  // the complete story of one Telegram message.
  await withLogContext({ updateId: update.update_id }, async () => {
    const started = Date.now();
    try {
      log.info('update received', {
        coldStart: consumeColdStart(),
        ...(await describeUpdate(update)),
      });

      if (!(await claimUpdate(update.update_id))) {
        // Expected whenever a previous delivery was slow, not itself a problem —
        // but if these appear *without* a matching 'update handled', the first
        // attempt is failing and the retry is being suppressed on top of it.
        log.info('duplicate update dropped', { ms: Date.now() - started });
        return;
      }

      const bot = await getBot(registerHandlers);
      // Separates "init hung" from "a handler hung" — both are otherwise silent.
      log.info('dispatching update', { readyMs: Date.now() - started });
      await bot.handleUpdate(update);

      const ms = Date.now() - started;
      // Telegram gives us roughly 3s before it assumes failure and redelivers.
      // Crossing that turns every message into a duplicate-suppressed no-op, so
      // it is worth shouting about before it becomes a mystery.
      if (ms > TELEGRAM_ACK_BUDGET_MS) {
        log.warn('update handled but over telegram ack budget', { ms });
      } else {
        log.info('update handled', { ms });
      }
    } catch (err) {
      // Always 200: a non-2xx puts Telegram into a retry loop, which turns one
      // broken update into a flood. The DLQ and logs are how we find out.
      log.error('update handling failed', { ms: Date.now() - started, ...errorFields(err) });
    }
  });

  return c.text('ok', 200);
});

/**
 * Describes an update's *shape* for the logs — kind, chat type, sender.
 *
 * Never the content. Message text and receipt item names stay out of
 * CloudWatch; for commands only the verb is recorded, so `/start <billId>` logs
 * as `/start`. The bill id arrives via its own context field anyway.
 */
async function describeUpdate(update: Update): Promise<Record<string, unknown>> {
  const msg = update.message ?? update.edited_message;
  if (!msg) {
    return { kind: Object.keys(update).find((k) => k !== 'update_id') ?? 'unknown' };
  }

  const kind = msg.photo
    ? 'photo'
    : msg.document
      ? 'document'
      : msg.text?.startsWith('/')
        ? 'command'
        : msg.text
          ? 'text'
          : 'other';

  return {
    kind,
    chatType: msg.chat.type,
    // Hashed, not raw — see userRef.
    from: await userRef(msg.from?.id),
    command: msg.text?.startsWith('/') ? msg.text.split(/\s+/)[0] : undefined,
    // Which of Telegram's rendered sizes we'd be pulling, useful when a parse
    // looks like it read a low-resolution image.
    photoSizes: msg.photo?.length,
    documentMime: msg.document?.mime_type,
  };
}

/* -------------------------------------------------------------- mini app */

interface AuthedBill {
  bill: Bill;
  userId: number;
}

/**
 * Resolves `:id` to a bill the caller is allowed to touch, or returns a
 * Response to hand straight back.
 *
 * The user id comes from verified initData only — never from the body.
 */
async function authorise(c: Context): Promise<AuthedBill | Response> {
  const initData = initDataFromAuthHeader(c.req.header('authorization'));
  if (!initData) return c.json({ error: 'unauthorized' }, 401);

  const verified = verifyInitData(initData, await botToken());
  if (!verified) return c.json({ error: 'unauthorized' }, 401);

  const billId = c.req.param('id');
  if (!isBillId(billId)) return c.json({ error: 'not found' }, 404);
  addLogContext({ billId, user: await userRef(verified.user.id) });

  const bill = await getBill(billId);
  if (!bill) return c.json({ error: 'not found' }, 404);

  // Admin-only assignment: only the payer can read or mutate the working bill.
  // Recipients see their share through the bot, not through this API.
  if (bill.adminId !== verified.user.id) {
    log.warn('bill access denied', { owner: await userRef(bill.adminId) });
    return c.json({ error: 'not found' }, 404);
  }

  return { bill, userId: verified.user.id };
}

app.get('/api/bills/:id', async (c) => {
  const authed = await authorise(c);
  if (authed instanceof Response) return authed;

  const bot = await getBot(registerHandlers);
  const body: GetBillResponse = {
    bill: authed.bill,
    botUsername: bot.botInfo.username,
  };
  return c.json(body);
});

app.patch('/api/bills/:id', async (c) => {
  const authed = await authorise(c);
  if (authed instanceof Response) return authed;
  const { bill } = authed;

  // Editable even after sending: an admin who spots a wrong price should be able
  // to fix it and re-send, not start over from the photo.

  let body: PatchBillRequest;
  try {
    body = (await c.req.json()) as PatchBillRequest;
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }

  const units = body.units === undefined ? bill.units : validateUnits(body.units);
  if (units === null) return c.json({ error: 'invalid units' }, 400);

  const total = body.total === undefined ? bill.total : body.total;
  if (!isCents(total) || total <= 0) return c.json({ error: 'invalid total' }, 400);

  const merchant = body.merchant === undefined ? bill.merchant : body.merchant.slice(0, 120);

  const currency = body.currency === undefined ? bill.currency : body.currency;
  if (!isSupportedCurrency(currency)) return c.json({ error: 'invalid currency' }, 400);

  // subtotal and factor are always derived, never accepted from the client.
  const subtotal = subtotalOf(units);
  const factor = deriveFactor(subtotal, total);

  await saveEdits(bill.billId, { merchant, currency, subtotal, total, factor, units });
  log.info('bill edited', { billId: bill.billId, currency, subtotal, total, factor });

  const updated: Bill = { ...bill, merchant, currency, subtotal, total, factor, units };
  return c.json({ bill: updated } satisfies { bill: Bill });
});

app.post('/api/bills/:id/finalise', async (c) => {
  const authed = await authorise(c);
  if (authed instanceof Response) return authed;
  const { bill } = authed;

  // Deliberately repeatable. An admin may send per-person, then want the group
  // version too, or notice the split is wrong. Re-finalising recomputes and
  // overwrites the shares, which is exactly what a correction should do.

  let body: FinaliseRequest;
  try {
    body = (await c.req.json()) as FinaliseRequest;
  } catch {
    return c.json({ error: 'invalid body' }, 400);
  }

  const people = validatePeople(body.people, bill.units);
  if (typeof people === 'string') return c.json({ error: people }, 400);

  // Belt and braces: computeShares refuses to reconcile with unclaimed units, but
  // a dedicated check gives a message worth showing a person.
  const claimed = new Set(people.flatMap((person) => person.unitIds));
  const unclaimed = bill.units.filter((unit) => !claimed.has(unit.id));
  if (unclaimed.length > 0) {
    const outstanding = unassignedCents(bill.units, people);
    return c.json(
      {
        error:
          `${unclaimed.length} item${unclaimed.length === 1 ? '' : 's'} ` +
          `(${formatMoney(outstanding, bill.currency)}) still need assigning`,
      },
      400,
    );
  }

  let shares: Share[];
  try {
    shares = computeShares(bill.units, bill.factor, bill.total, people);
  } catch (err) {
    if (err instanceof CalcError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // Never trusted from the client as-is: name is trimmed and capped, phone is
  // normalised or dropped. A blank name means "no payee", not an error.
  const rawPayee = cleanPayee(body.payee);

  // An out-of-range index would silently mark the wrong person as the payer, so
  // drop it rather than guess. The name survives either way.
  const payee =
    rawPayee && rawPayee.personIndex !== undefined && rawPayee.personIndex >= people.length
      ? { ...rawPayee, personIndex: undefined }
      : rawPayee;

  // Anything but an explicit 'group' means per-person, so a client that doesn't
  // send the field keeps the original behaviour.
  const mode: SendMode = body.mode === 'group' ? 'group' : 'personal';

  // Phone stripped here — toStoredPayee is the only way payee data reaches the
  // database, and it has no field for one.
  await saveShares(bill.billId, shares, toStoredPayee(payee));
  log.info('bill finalised', {
    people: shares.length,
    total: bill.total,
    sum: shares.reduce((a, s) => a + s.cents, 0),
    // Whether one was given, never the number itself — it is someone's personal
    // contact detail, and at 14 days the logs outlive the bill's 24 hours.
    mode,
    hasPayee: payee !== null,
    hasPayeePhone: Boolean(payee?.phone),
  });

  // One forwardable message per person, DM'd to the admin.
  const bot = await getBot(registerHandlers);
  const finalBill: Bill = {
    ...bill,
    shares,
    status: 'final',
    payee: toStoredPayee(payee) ?? undefined,
  };
  // `payee` (not finalBill.payee) throughout, so the phone reaches the messages
  // the admin forwards without ever being written down.
  let allSent = true;

  const send = async (text: string, label: string): Promise<void> => {
    try {
      await bot.api.sendMessage(bill.adminId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      // Don't fail the whole request over one message — but do remember, because
      // it decides whether the bill is safe to delete below.
      allSent = false;
      log.error('share message send failed', { part: label, ...errorFields(err) });
    }
  };

  if (mode === 'group') {
    await send(
      consolidatedMessage(finalBill, shares, bot.botInfo.username, payee ?? undefined),
      'consolidated',
    );
  } else {
    for (const share of shares) {
      await send(
        shareMessage(finalBill, share, bot.botInfo.username, payee ?? undefined),
        `share-${share.idx}`,
      );
    }
  }

  if (!allSent) log.warn('not every message was delivered');

  return c.json({ shares } satisfies FinaliseResponse);
});

/**
 * Answers CORS preflights.
 *
 * API Gateway is configured with `cors_configuration` and does attach the
 * Access-Control-* headers, but it would only answer preflights itself if no
 * route matched them. Our catch-all `ANY /{proxy+}` matches OPTIONS as well, so
 * the preflight reaches Hono — which had no OPTIONS route and returned 404.
 *
 * A preflight must answer 2xx or the browser refuses to send the real request,
 * and the failure surfaces in the Mini App as a bare network error with no
 * status to report. Every Mini App call sends `Authorization: tma <initData>`,
 * which makes all of them non-simple requests, so every one is preflighted.
 *
 * Deliberately no Hono CORS middleware here: API Gateway already supplies the
 * headers, and a second set would produce duplicates, which browsers reject.
 */
app.options('/*', (c) => c.body(null, 204));

app.get('/health', (c) => c.json({ ok: true }));

/* ------------------------------------------------------------ validation */

function validateUnits(input: unknown): Unit[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 200) return null;

  const seen = new Set<string>();
  const units: Unit[] = [];

  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) return null;
    const unit = raw as Partial<Unit>;
    if (typeof unit.id !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(unit.id)) return null;
    if (seen.has(unit.id)) return null;
    seen.add(unit.id);
    if (!isCents(unit.cents) || unit.cents < 0) return null;
    if (typeof unit.displayName !== 'string') return null;

    units.push({
      id: unit.id,
      name: typeof unit.name === 'string' ? unit.name.slice(0, 120) : unit.displayName.slice(0, 120),
      displayName: unit.displayName.slice(0, 120) || unit.id,
      cents: unit.cents,
      shared: unit.shared === true,
    });
  }

  return units;
}

/** Returns the assignments, or an error string suitable for the client. */
function validatePeople(
  input: unknown,
  units: Unit[],
): { name: string; unitIds: string[] }[] | string {
  if (!Array.isArray(input)) return 'people must be an array';
  if (input.length < MIN_PEOPLE) return `at least ${MIN_PEOPLE} people are needed`;
  if (input.length > MAX_PEOPLE) return `at most ${MAX_PEOPLE} people are supported`;

  const validIds = new Set(units.map((u) => u.id));
  const people: { name: string; unitIds: string[] }[] = [];

  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) return 'invalid person';
    const person = raw as { name?: unknown; unitIds?: unknown };
    if (typeof person.name !== 'string' || person.name.trim() === '') return 'every person needs a name';
    if (!Array.isArray(person.unitIds)) return 'invalid unit assignment';

    const unitIds: string[] = [];
    for (const id of person.unitIds) {
      if (typeof id !== 'string' || !validIds.has(id)) return 'invalid unit assignment';
      unitIds.push(id);
    }

    people.push({ name: person.name.trim().slice(0, 40), unitIds: [...new Set(unitIds)] });
  }

  return people;
}

export const handler = handle(app);
