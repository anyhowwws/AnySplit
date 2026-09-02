import { createHmac } from 'node:crypto';
import { userRefSalt } from './secrets.ts';

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
 * A dedicated SSM parameter, not the bot token.
 *
 * The token was the obvious key — high-entropy, already in SSM, already fetched
 * by both Lambdas — and it was fine while these references only appeared in
 * logs that expire after 14 days. It stopped being fine once they became the
 * key of a usage row meant to outlive everything: rotating the token would
 * re-hash every user, so everyone already counted would be counted again as
 * new, and the one statistic these references exist to produce would quietly
 * break.
 *
 * The deeper problem was the coupling. Rotation is what you do when a token
 * leaks, and it should never carry a hidden cost that makes anyone hesitate.
 * These are now independent: rotate the token freely, and the references hold.
 *
 * Rotating *this* parameter does re-key everything, so it should not be
 * rotated — it protects no access, only the linkability of a count.
 */
function salt(): Promise<string> {
  if (!saltPromise) saltPromise = userRefSalt();
  return saltPromise;
}

/** 12 hex chars: ample to avoid collisions at this volume, short enough to scan. */
export async function userRef(id: number | undefined): Promise<string | undefined> {
  if (id === undefined) return undefined;
  return createHmac('sha256', await salt()).update(String(id)).digest('hex').slice(0, 12);
}
