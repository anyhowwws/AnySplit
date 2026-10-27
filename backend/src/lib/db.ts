import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Bill, BillStatus, Receipt, Share, Unit } from '../../../shared/types.ts';
import type { StoredPayee } from '../../../shared/payee.ts';
import { DEFAULT_CURRENCY } from '../../../shared/currency.ts';
import { FIRST_RECEIPT_ID } from '../../../shared/receipts.ts';
import { config } from './config.ts';
import { log } from './log.ts';
import { userRef } from './userref.ts';
import { bumpUserCount, USER_KEY_PREFIX } from './usercount.ts';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Unix epoch seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function ttlFromNow(): number {
  return now() + config.ttlSeconds();
}

export async function putBill(bill: Bill): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tableName(),
      Item: bill,
    }),
  );
}

/**
 * Single GetItem. DynamoDB TTL deletion is not immediate — AWS typically
 * deletes within 48 hours of expiry — so we re-check `ttl` on read and treat an
 * expired item as absent. Two lines of code, and it makes the 24-hour retention
 * promise honest rather than aspirational.
 *
 * The `ttl`-less rows — the `usr#` usage rows recordUse writes, and the
 * `meta#users` counter that sits beside them — are never read through here,
 * and the check below only skips items that *have* an expiry, so they would
 * survive it regardless.
 */
export async function getBill(billId: string): Promise<Bill | null> {
  const result = await client.send(
    new GetCommand({ TableName: config.tableName(), Key: { billId } }),
  );
  const item = result.Item as (Bill & Partial<LegacyBillBody>) | undefined;
  if (!item) return null;
  if (typeof item.ttl === 'number' && item.ttl <= now()) {
    log.info('bill read after ttl expiry, treating as absent', { billId, ttl: item.ttl });
    return null;
  }
  return item.receipts ? item : fromLegacy(item);
}

/**
 * The fields a bill carried at its top level before they moved into
 * `receipts`. Only ever read, by `fromLegacy`; nothing writes them any more.
 */
interface LegacyBillBody {
  merchant: string;
  currency?: string;
  subtotal: number;
  total: number;
  factor: number;
  units: Unit[];
  serviceCharge?: number;
  gst?: number;
  discount?: number;
}

/**
 * Reads a bill written before receipts existed as a bill with one receipt.
 *
 * No migration: bills live 24 hours, so every such row is gone a day after
 * this ships, and this — with saveReceipt's fallback — can go with them. Unit
 * ids are kept as they were, because a final bill's shares refer to them.
 *
 * `note` meant both things on a legacy bill: why the parse failed, or what to
 * check in a parse that landed. The first stays on the bill, the second
 * belongs to the receipt.
 */
function fromLegacy(item: Bill & Partial<LegacyBillBody>): Bill {
  const {
    merchant, currency, subtotal, total, factor, units, serviceCharge, gst, discount, note,
    ...rest
  } = item;
  const receipt: Receipt = {
    receiptId: FIRST_RECEIPT_ID,
    seq: 0,
    merchant: merchant ?? '',
    // Bills written before multi-currency support have no `currency` field.
    // They were always SGD — that was the only currency AnySplit understood.
    currency: currency || DEFAULT_CURRENCY,
    subtotal: subtotal ?? 0,
    total: total ?? 0,
    factor: factor ?? 1,
    units: units ?? [],
    serviceCharge,
    gst,
    discount,
    note: item.status === 'error' ? undefined : (note ?? undefined),
  };
  return {
    ...rest,
    receipts: { [FIRST_RECEIPT_ID]: receipt },
    note: item.status === 'error' ? (note ?? undefined) : undefined,
  };
}

/** True for DynamoDB's "the condition didn't hold" — the expected refusal. */
function conditionFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

/**
 * Writes one receipt, and optionally the bill's status, in one update.
 * Returns false when the receipt is no longer on the bill — removed while its
 * photo was being read, or while the admin was editing it.
 *
 * A per-receipt path, `receipts.<id>`, so two receipts saving at once can't
 * overwrite each other. The condition is also what stops a parse for a
 * removed receipt quietly bringing it back.
 *
 * A row written before `receipts` existed has no map to write into, so it
 * gets the whole map instead, with its old top-level body removed. Such rows
 * hold one receipt, so there's no sibling to lose; the last of them expires
 * 24 hours after 2026-10-27T17:47Z, after which the fallback can go with
 * `fromLegacy`.
 */
export async function saveReceipt(
  bill: Bill,
  receipt: Receipt,
  status?: BillStatus,
): Promise<boolean> {
  const names: Record<string, string> = { '#receipts': 'receipts', '#rid': receipt.receiptId };
  const values: Record<string, unknown> = { ':r': receipt };
  let set = '#receipts.#rid = :r';
  if (status) {
    names['#status'] = 'status';
    values[':st'] = status;
    set += ', #status = :st';
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId: bill.billId },
        UpdateExpression: `SET ${set}`,
        ConditionExpression: 'attribute_exists(#receipts.#rid)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (!conditionFailed(err)) throw err;
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId: bill.billId },
        UpdateExpression:
          `SET #receipts = :all${status ? ', #status = :st' : ''} ` +
          'REMOVE merchant, currency, subtotal, #total, factor, units, serviceCharge, gst, discount',
        ConditionExpression: 'attribute_not_exists(#receipts)',
        ExpressionAttributeNames: {
          '#receipts': 'receipts',
          '#total': 'total',
          ...(status ? { '#status': 'status' } : {}),
        },
        ExpressionAttributeValues: {
          ':all': { ...bill.receipts, [receipt.receiptId]: receipt },
          ...(status ? { ':st': status } : {}),
        },
      }),
    );
    log.info('legacy bill rewritten with receipts', { billId: bill.billId });
    return true;
  } catch (err) {
    // The row has a receipts map after all, just not this receipt in it.
    if (conditionFailed(err)) return false;
    throw err;
  }
}

/**
 * Adds a receipt — a placeholder whose photo is about to be read — and
 * restarts the bill's retention clock, since adding to it is using it.
 *
 * The cap is checked in the same conditional write, so two adds racing for
 * the last slot can't both get it.
 */
export async function addReceipt(
  billId: string,
  receipt: Receipt,
  maxReceipts: number,
): Promise<'added' | 'full' | 'missing'> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId },
        UpdateExpression: 'SET #receipts.#rid = :r, #ttl = :ttl',
        ConditionExpression: 'attribute_exists(#receipts) AND size(#receipts) < :max',
        ExpressionAttributeNames: { '#receipts': 'receipts', '#rid': receipt.receiptId, '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':r': receipt, ':ttl': ttlFromNow(), ':max': maxReceipts },
      }),
    );
    return 'added';
  } catch (err) {
    if (!conditionFailed(err)) throw err;
  }
  // Which condition failed isn't reported, so look. A bill that's gone also
  // has no receipts attribute, which is why the add couldn't tell them apart.
  const bill = await getBill(billId);
  return bill ? 'full' : 'missing';
}

/**
 * Removes one receipt. Refuses — returns false — when it's the last one, or
 * already gone: a bill with no receipts has nothing to split.
 */
export async function removeReceipt(billId: string, receiptId: string): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId },
        UpdateExpression: 'REMOVE #receipts.#rid',
        ConditionExpression: 'attribute_exists(#receipts.#rid) AND size(#receipts) > :one',
        ExpressionAttributeNames: { '#receipts': 'receipts', '#rid': receiptId },
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
    return true;
  } catch (err) {
    if (conditionFailed(err)) return false;
    throw err;
  }
}

/**
 * Marks a receipt unreadable. For a bill's first receipt the whole bill is,
 * too — there's nothing else on it — and `note` goes on the bill, where the
 * Mini App looks for it. A receipt removed in the meantime is left removed.
 */
export async function markReceiptFailed(
  billId: string,
  receiptId: string,
  reason: string,
  wholeBill: boolean,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId },
        UpdateExpression:
          'SET #receipts.#rid.#status = :err, #receipts.#rid.note = :n' +
          (wholeBill ? ', #status = :err, note = :n' : ''),
        ConditionExpression: 'attribute_exists(#receipts.#rid)',
        ExpressionAttributeNames: { '#receipts': 'receipts', '#rid': receiptId, '#status': 'status' },
        ExpressionAttributeValues: { ':err': 'error', ':n': reason },
      }),
    );
  } catch (err) {
    if (!conditionFailed(err)) throw err;
  }
}

/**
 * "The next photo this person sends belongs on this bill" — set by the Add
 * another receipt button, consumed by that photo.
 *
 * Short-lived on purpose: a photo sent hours later is far more likely a new
 * meal than the rest of the old one. Keyed by Telegram id, as the bill's own
 * `adminId` is, and gone within minutes.
 */
const ATTACH_TTL_SECONDS = 15 * 60;

export async function setAttach(userId: number, billId: string): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tableName(),
      Item: { billId: `att#${userId}`, target: billId, ttl: now() + ATTACH_TTL_SECONDS },
    }),
  );
}

/**
 * Consumes the marker, returning the bill it names, or null. A delete that
 * returns what it deleted, so two photos sent together can't both claim it.
 *
 * Fails open to null, like claimUpdate: every photo passes through here, so a
 * failure must cost at most the attachment — the photo still starts a bill of
 * its own — never the photo itself. Logged at error, because it means the
 * button has silently stopped working.
 */
export async function takeAttach(userId: number): Promise<string | null> {
  let result;
  try {
    result = await client.send(
      new DeleteCommand({
        TableName: config.tableName(),
        Key: { billId: `att#${userId}` },
        ReturnValues: 'ALL_OLD',
      }),
    );
  } catch (err) {
    log.error('attach marker read failed, starting a new bill', { err: String(err) });
    return null;
  }
  const item = result.Attributes as { target?: string; ttl?: number } | undefined;
  if (!item?.target || typeof item.ttl !== 'number' || item.ttl <= now()) return null;
  return item.target;
}

export async function saveShares(
  billId: string,
  shares: Share[],
  payee: StoredPayee | null,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: config.tableName(),
      Key: { billId },
      UpdateExpression: 'SET shares = :sh, #status = :st, payee = :p, #ttl = :ttl',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':sh': shares,
        ':st': 'final' satisfies BillStatus,
        // Null rather than undefined: an explicit absence is easier to read back
        // than a missing attribute, and removeUndefinedValues would drop it.
        ':p': payee,
        // Restart the retention clock rather than deleting outright. Sending is
        // not the end of the story: an admin may want the other format, or spot
        // that the split is wrong, and a bill that vanished the instant it was
        // sent made both impossible. One rule now — gone 24h after the last
        // action — which is simple to explain and nearly as short.
        ':ttl': ttlFromNow(),
      },
    }),
  );
}

/**
 * Records that someone used the bot, so "how many people use this" is
 * answerable without keeping anything about what they did.
 *
 * The key is the HMAC reference from userref.ts, never the Telegram id, so this
 * row cannot be turned back into a person. It holds a first-seen, a last-seen
 * and a count — no bills, no names, no merchants. Knowing that a pseudonym has
 * split fourteen receipts says nothing about whose they were.
 *
 * Deliberately one of only two kinds of item in this table with **no** `ttl`
 * — the other being the `meta#users` total in usercount.ts, which counts these
 * rows. Everything else expires; this is a count that has to outlive what it
 * counted. Anything added here later must stay aggregate for that reason — the
 * moment a row carries per-bill detail it becomes the history the privacy
 * policy says is not kept.
 *
 * A conditional create attempt first, exactly like claimUpdate below, so
 * whether this pseudonym has ever been seen before is answered unambiguously
 * by which branch runs rather than inferred from an update's side effects.
 *
 * That branch is the one moment a person is ever counted, so it does both
 * things counting means: it emits the `new user` line that feeds the NewUsers
 * metric filter in monitoring.tf — which the daily report reads as "new users
 * today" — and it bumps the running total in usercount.ts, which the report
 * reads as "total unique users". See usercount.ts for why the total is kept
 * here rather than summed back out of the metric.
 */
export async function recordUse(userId: number | undefined): Promise<void> {
  const ref = await userRef(userId);
  if (!ref) return;

  const key = { billId: `${USER_KEY_PREFIX}${ref}` };

  let created = false;

  try {
    await client.send(
      new PutCommand({
        TableName: config.tableName(),
        Item: { ...key, firstSeen: now(), lastSeen: now(), parses: 0 },
        ConditionExpression: 'attribute_not_exists(billId)',
      }),
    );
    created = true;
  } catch (err) {
    if (!(err instanceof Error && err.name === 'ConditionalCheckFailedException')) {
      // Never fail a split over bookkeeping. A missed count is a worse
      // statistic; a thrown error here would be a user who couldn't split
      // their bill.
      log.warn('usage record failed', { err: String(err) });
      return;
    }
  }

  // Outside the try above on purpose: its catch means "the conditional create
  // failed", and neither of these is that. Reaching here at all means the row
  // exists, and `created` says whether this call is what made it.
  if (created) {
    const totalUsers = await bumpUserCount();
    log.info('new user', { totalUsers });
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: key,
        UpdateExpression: 'SET lastSeen = :now ADD parses :one',
        ExpressionAttributeValues: { ':now': now(), ':one': 1 },
      }),
    );
  } catch (err) {
    log.warn('usage record failed', { err: String(err) });
  }
}

/**
 * Consumes one unit from a fixed-window counter. Returns false when the window
 * is already full.
 *
 * The whole check is a single conditional UpdateItem: increment, but only if
 * the counter is below the ceiling. DynamoDB evaluates the condition and the
 * increment as one atomic operation, so two Lambdas racing on the same key
 * cannot both succeed on the last remaining unit — which a read-then-write
 * would happily allow.
 *
 * Windows are fixed rather than sliding: the key carries the window's start, so
 * counters partition themselves and expire on their own via `ttl` instead of
 * needing to be swept. The cost of that simplicity is the boundary case — a
 * user can spend a full window's allowance either side of a rollover and get
 * double the nominal rate briefly. For a ceiling that exists to stop runaway
 * spend rather than to meter fairly, that is an acceptable trade against
 * keeping a sliding log of every request.
 */
export async function claimQuota(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const windowStart = Math.floor(now() / windowSeconds) * windowSeconds;

  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId: `rl#${key}#${windowStart}` },
        UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :exp) ADD hits :one',
        ConditionExpression: 'attribute_not_exists(hits) OR hits < :max',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':max': max,
          // A few minutes past the window so a clock skew can't resurrect a
          // counter that should have lapsed.
          ':exp': windowStart + windowSeconds + 300,
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    // Fail open, matching claimUpdate. A DynamoDB blip should not stop people
    // splitting bills, and the vision-call-volume alarm still catches a flood
    // that slips through — an outage degrades the ceiling to detection rather
    // than removing it.
    log.warn('quota check failed open', { key, err: String(err) });
    return true;
  }
}

/**
 * Telegram retries any webhook that doesn't get a fast 200, so the same
 * update_id can arrive several times. First caller wins; later callers get
 * false and drop the update.
 *
 * Dedupe markers live in the bills table under a `upd#` prefix — a second table
 * for this would be pure ceremony. They carry a 1-hour TTL, well past
 * Telegram's retry window.
 */
export async function claimUpdate(updateId: number): Promise<boolean> {
  try {
    await client.send(
      new PutCommand({
        TableName: config.tableName(),
        Item: { billId: `upd#${updateId}`, ttl: now() + 3600 },
        ConditionExpression: 'attribute_not_exists(billId)',
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    // A DynamoDB outage should not stop us acking Telegram. Process the update
    // and accept the small risk of double-processing over a retry storm.
    log.warn('claimUpdate failed open', { updateId, err: String(err) });
    return true;
  }
}
