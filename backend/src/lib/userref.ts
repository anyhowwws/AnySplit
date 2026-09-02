import { createHmac } from 'node:crypto';
import { botToken } from './secrets.ts';

/**
 * A stable, non-reversible stand-in for a Telegram user id.
 *
 * Used in two places: every log line that would otherwise carry a raw id, and
 * the key of the usage rows in db.ts. Logs outlive a bill — 14 days against 24
 * hours — and the usage rows outlive everything, so raw ids in either would
 * quietly make them the most identifying store in the system.
 *
 * Plain SHA-256 would not help: Telegram ids are ~10 digits, so the whole space
 * is trivially enumerable and the "hash" would be reversible by anyone holding
 * the output. Keying the HMAC with a secret closes that off.
 *
 * The reference is stable for a given user, so "how many distinct people used
 * this" stays answerable, and a specific user's session can still be traced by
 * hashing their id the same way. What is not possible is reading an identity
 * back out.
 */

let saltPromise: Promise<string> | null = null;

/**
 * The bot token doubles as the HMAC key: high-entropy, already in SSM, already
 * fetched by both Lambdas, so a dedicated salt would be one more secret to
 * provision for no additional protection.
 *
 * One consequence to know about, now that these references key a permanent
 * usage row rather than only a 14-day log line. **Rotating the bot token
 * re-hashes every user**, so everyone seen before the rotation is counted again
 * as new and the unique-user total steps up. Nothing is lost or exposed — the
 * old rows simply become unreachable — but the statistic breaks at that point.
 * If the token ever needs rotating, move this key to its own SSM parameter
 * first and the references survive.
 */
function salt(): Promise<string> {
  if (!saltPromise) saltPromise = botToken();
  return saltPromise;
}

/** 12 hex chars: ample to avoid collisions at this volume, short enough to scan. */
export async function userRef(id: number | undefined): Promise<string | undefined> {
  if (id === undefined) return undefined;
  return createHmac('sha256', await salt()).update(String(id)).digest('hex').slice(0, 12);
}
