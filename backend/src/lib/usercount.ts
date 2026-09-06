import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from './config.ts';
import { log } from './log.ts';

/**
 * How many distinct people have ever used AnySplit — counted from day 0.
 *
 * Its own module because two very different callers need to agree on it: the
 * write path (`recordUse` in db.ts, running in `api`) and the read path (the
 * daily report, running in a Lambda that is deliberately not allowed to read a
 * bill). Keeping the keys and the arithmetic in one file is what stops those
 * two from drifting into two different answers to the same question.
 *
 * **Why this is not derived from CloudWatch.** It used to be: `NewUsers` is a
 * metric filter on the `new user` log line, and summing it over the metric's
 * ~15-month retention looked like "total unique users" for free. It is not. A
 * metric filter has no history — it begins at zero the moment Terraform creates
 * it and can never see a log line written before that. The first real user of
 * this bot predates the filter, so the sum said 1 while the table held 2. The
 * `usr#` rows are the thing that has been true since day 0; the metric is only
 * a live feed of what has happened since it was switched on. So `NewUsers`
 * still answers "new users today", and the running total now comes from here.
 *
 * **Why a counter rather than counting the rows.** The `usr#` rows are the
 * ground truth, but counting them is a Scan, and a Scan cannot be scoped to a
 * key prefix by IAM — granting it to the report Lambda would grant reading
 * every bill in the table, which is exactly the blast radius report.tf exists
 * to avoid. So the total is also maintained as a single atomic counter, written
 * in the same breath as the row it counts, and the report reads that one item
 * under a `dynamodb:LeadingKeys` condition pinning it to that key alone.
 *
 * The counter is a cache of a countable fact, so it can be checked rather than
 * trusted: `countUserRows` below recounts from the rows, and `scripts/users.ts`
 * compares the two and repairs the counter. Those last two need
 * `dynamodb:Scan` and an unconditional write, which neither Lambda role is
 * granted (infra/iam.tf, infra/report.tf) — they are here so that there is one
 * definition of what a user is, and the IAM boundary rather than the module
 * boundary is what keeps them out of the bot's reach.
 */

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Key prefix of the per-person usage rows — one per distinct pseudonym, no
 * `ttl`, written by `recordUse`. The ground truth behind the counter.
 */
export const USER_KEY_PREFIX = 'usr#';

/**
 * The single item holding the running total.
 *
 * Kept in the bills table rather than a table of its own: one item does not
 * earn its own infrastructure. Bill ids carry 72 bits of entropy, so this
 * cannot collide with one.
 *
 * Changing this string is a breaking change in two places at once — the
 * `dynamodb:LeadingKeys` condition in infra/report.tf pins the report role's
 * read to this exact value.
 */
export const USER_COUNT_KEY = 'meta#users';

/**
 * Adds one to the total. Returns the new value, or undefined if the write
 * failed.
 *
 * `ADD` is an atomic increment evaluated by DynamoDB, not a read-then-write, so
 * two `api` invocations enrolling different people at the same moment cannot
 * lose one of each other's increments.
 *
 * Never throws: the caller is in the middle of someone's bill, and a bad
 * statistic is a far better outcome than a split that failed over bookkeeping.
 * A failure here shows up as drift the reconcile script can see and repair.
 */
export async function bumpUserCount(): Promise<number | undefined> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: { billId: USER_COUNT_KEY },
        UpdateExpression: 'ADD #users :one',
        ExpressionAttributeNames: { '#users': 'users' },
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const users = result.Attributes?.users;
    return typeof users === 'number' ? users : undefined;
  } catch (err) {
    log.warn('user count bump failed', { err: String(err) });
    return undefined;
  }
}

/**
 * Reads the running total. A single GetItem on one known key.
 *
 * Absent reads as 0 rather than throwing: that is the honest answer for a
 * freshly deployed stack that nobody has used yet, which is otherwise
 * indistinguishable from a broken one on its first morning.
 */
export async function readUserCount(): Promise<number> {
  const result = await client.send(
    new GetCommand({ TableName: config.tableName(), Key: { billId: USER_COUNT_KEY } }),
  );
  const users = result.Item?.users;
  return typeof users === 'number' ? users : 0;
}

/** The aggregate fields on a `usr#` row. Never the key: that is the pseudonym. */
export interface UserRow {
  firstSeen?: number;
  lastSeen?: number;
  parses?: number;
}

/**
 * Every `usr#` row — the ground truth the counter is a cache of, and the answer
 * to "how many people have used this since day 0" that depends on nothing but
 * the rows themselves.
 *
 * Paginated, because a Scan returns at most 1MB per call and reading only the
 * first page would quietly under-report the moment this outgrows it.
 */
export async function countUserRows(): Promise<UserRow[]> {
  const rows: UserRow[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: config.tableName(),
        FilterExpression: 'begins_with(billId, :prefix)',
        ExpressionAttributeValues: { ':prefix': USER_KEY_PREFIX },
        ProjectionExpression: 'firstSeen, lastSeen, parses',
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...((result.Items ?? []) as UserRow[]));
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return rows;
}

/**
 * Overwrites the counter with a known-good value. Repair, not arithmetic — the
 * only caller is the reconcile path in scripts/users.ts, after a recount.
 */
export async function setUserCount(users: number): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tableName(),
      Item: { billId: USER_COUNT_KEY, users, reconciledAt: Math.floor(Date.now() / 1000) },
    }),
  );
}
