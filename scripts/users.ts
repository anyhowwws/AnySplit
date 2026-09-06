/**
 * How many distinct people have used AnySplit, counted from the table rather
 * than inferred from a metric.
 *
 *   cd backend && npm run users                  # report
 *   cd backend && npm run users -- --reconcile   # repair the counter
 *
 * Needs AWS credentials for the deployment — the same `AWS_PROFILE=terraform`
 * the rest of the operational tooling uses. BILLS_TABLE and AWS_REGION default
 * to the live stack in the npm script; override them for another deployment.
 *
 * Two numbers, from two places, that should always agree:
 *
 *   - the `usr#` rows, one per distinct pseudonym, no `ttl`, written since the
 *     day the bot went up. This is the ground truth, and counting it is a Scan.
 *   - the `meta#users` counter, incremented alongside each of those rows, which
 *     is what the daily report reads because the report Lambda is deliberately
 *     not allowed to Scan. See backend/src/lib/usercount.ts.
 *
 * A counter can drift: a DynamoDB write can fail after the row it counts
 * succeeded, and recordUse swallows that rather than failing someone's split.
 * So it is never trusted blind — this recounts, and `--reconcile` sets the
 * counter to what the rows actually say.
 */

import { config } from '../backend/src/lib/config.ts';
import { countUserRows, readUserCount, setUserCount } from '../backend/src/lib/usercount.ts';

const reconcile = process.argv.includes('--reconcile');

const rows = await countUserRows();
const counted = rows.length;
const counter = await readUserCount();

const firstSeen = Math.min(...rows.map((r) => r.firstSeen ?? Infinity));
const lastSeen = Math.max(...rows.map((r) => r.lastSeen ?? 0));
const parses = rows.reduce((sum, row) => sum + (row.parses ?? 0), 0);

function day(seconds: number): string {
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString().slice(0, 10)
    : '—';
}

console.log(`AnySplit users — ${config.tableName()}\n`);
console.log(`  Unique users:     ${counted}`);
console.log(`  Counter:          ${counter}`);
console.log(`  Receipts parsed:  ${parses}`);
console.log(`  Active:           ${day(firstSeen)} to ${day(lastSeen)}`);

if (counter === counted) {
  console.log('\nCounter agrees with the rows.');
} else if (reconcile) {
  await setUserCount(counted);
  console.log(`\nReconciled: counter ${counter} -> ${counted}.`);
} else {
  const gap = counted - counter;
  console.log(`\nDRIFT: the counter is ${Math.abs(gap)} ${gap > 0 ? 'behind' : 'ahead of'} the rows.`);
  console.log('The daily report reads the counter, so it is wrong until this is fixed.');
  console.log('Re-run with --reconcile to set it to the counted value.');
}
