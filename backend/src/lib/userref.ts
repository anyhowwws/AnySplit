import { createHmac } from 'node:crypto';
import { botToken } from './secrets.ts';

/**
 * A stable, non-reversible stand-in for a Telegram user id, for logging.
 *
 * Now that bills are deleted the moment their messages send, CloudWatch is the
 * only place holding anything about who used the bot — and it retains for 14
 * days, outliving the bill itself. Logging raw ids there would quietly make the
 * logs the most identifying store in the system.
 *
 * Plain SHA-256 would not help: Telegram ids are ~10 digits, so the whole space
 * is trivially enumerable and the "hash" would be reversible by anyone with the
 * log. Keying the HMAC with a secret closes that off.
 *
 * The reference is stable for a given user, so "how many distinct people used
 * this" is still answerable, and a specific user's session can still be traced
 * by hashing their id the same way. What is no longer possible is reading an
 * identity straight out of the logs.
 */

let saltPromise: Promise<string> | null = null;

/**
 * The bot token doubles as the HMAC key. It is high-entropy, already in SSM,
 * and already fetched by both Lambdas — a dedicated salt parameter would be one
 * more secret to provision and rotate for no additional protection.
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
