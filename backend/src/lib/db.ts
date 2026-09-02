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
 * The `ttl`-less usage rows written by recordUse are never read through here —
 * they are keyed `usr#`, and the check below only skips items that *have* an
 * expiry, so they would survive it regardless.
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
 * Deliberately the only item in this table with **no** `ttl`. Everything else
 * expires; this is a count that has to outlive what it counted. Anything added
 * here later must stay aggregate for that reason — the moment a row carries
 * per-bill detail it becomes the history the privacy policy says is not kept.
 */
export async function recordUse(userId: number | undefined): Promise<void> {
  const ref = await userRef(userId);
  if (!ref) return;

  try {
    await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId: `usr#${ref}` },
        UpdateExpression:
          'SET firstSeen = if_not_exists(firstSeen, :now), lastSeen = :now ADD parses :one',
        ExpressionAttributeValues: { ':now': now(), ':one': 1 },
      }),
    );
  } catch (err) {
    // Never fail a split over bookkeeping. A missed count is a worse statistic;
    // a thrown error here would be a user who couldn't split their bill.
    log.warn('usage record failed', { err: String(err) });
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
