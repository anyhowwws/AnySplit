import { createHmac, timingSafeEqual } from 'node:crypto';
import { INITDATA_MAX_AGE_SECONDS } from './config.ts';
import { now } from './db.ts';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: number;
  /** `start_param` from a `?startapp=` launch, if any. */
  startParam?: string;
}

/**
 * Verifies a Telegram Mini App initData string.
 *
 * NEVER trust a user_id from a request body. The verified `user.id` returned
 * here is the only identity the API acts on.
 *
 * Returns null on any failure — bad signature, missing fields, stale auth_date.
 * Callers turn that into a flat 401 without explaining which check failed.
 */
export function verifyInitData(initData: string, botToken: string): VerifiedInitData | null {
  if (!initData) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;

  // data_check_string: every field except `hash`, sorted by key, joined k=v\n
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (!constantTimeEqualHex(expected, hash)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  // A replayed initData string stays valid forever without this check.
  if (now() - authDate > INITDATA_MAX_AGE_SECONDS) return null;

  const rawUser = params.get('user');
  if (!rawUser) return null;

  let user: TelegramUser;
  try {
    user = JSON.parse(rawUser) as TelegramUser;
  } catch {
    return null;
  }
  if (typeof user.id !== 'number') return null;

  return {
    user,
    authDate,
    startParam: params.get('start_param') ?? undefined,
  };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Pulls initData out of an `Authorization: tma <initData>` header.
 * `tma` is the scheme Telegram's own docs use for this.
 */
export function initDataFromAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^tma\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
