import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Bill, BillStatus, Share, Unit } from '../../../shared/types.ts';
import type { StoredPayee } from '../../../shared/payee.ts';
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
  const item = result.Item as Bill | undefined;
  if (!item) return null;
  if (typeof item.ttl === 'number' && item.ttl <= now()) {
    log.info('bill read after ttl expiry, treating as absent', { billId, ttl: item.ttl });
    return null;
  }
  return item;
}

/** Overwrites the parsed body of a bill once the vision call returns. */
export async function saveParse(
  billId: string,
  fields: {
    merchant: string;
    subtotal: number;
    total: number;
    factor: number;
    units: Unit[];
    serviceCharge: number;
    gst: number;
    discount: number;
    status: BillStatus;
    note?: string;
  },
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: config.tableName(),
      Key: { billId },
      UpdateExpression:
        'SET merchant = :m, subtotal = :s, #total = :t, factor = :f, units = :u, ' +
        'serviceCharge = :sc, gst = :g, discount = :d, #status = :st, note = :n',
      ExpressionAttributeNames: { '#status': 'status', '#total': 'total' },
      ExpressionAttributeValues: {
        ':m': fields.merchant,
        ':s': fields.subtotal,
        ':t': fields.total,
        ':f': fields.factor,
        ':u': fields.units,
        ':sc': fields.serviceCharge,
        ':g': fields.gst,
        ':d': fields.discount,
        ':st': fields.status,
        ':n': fields.note ?? null,
      },
    }),
  );
}

/** Admin corrections from the Review screen. */
export async function saveEdits(
  billId: string,
  fields: { merchant: string; subtotal: number; total: number; factor: number; units: Unit[] },
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: config.tableName(),
      Key: { billId },
      UpdateExpression:
        'SET merchant = :m, subtotal = :s, #total = :t, factor = :f, units = :u',
      ExpressionAttributeNames: { '#total': 'total' },
      ExpressionAttributeValues: {
        ':m': fields.merchant,
        ':s': fields.subtotal,
        ':t': fields.total,
        ':f': fields.factor,
        ':u': fields.units,
      },
    }),
  );
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

export async function setStatus(
  billId: string,
  status: BillStatus,
  note?: string,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: config.tableName(),
      Key: { billId },
      UpdateExpression: 'SET #status = :st, note = :n',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':st': status, ':n': note ?? null },
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
