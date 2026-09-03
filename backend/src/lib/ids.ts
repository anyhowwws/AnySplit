import { randomBytes } from 'node:crypto';

/**
 * 12-char base64url bill id. 72 bits of entropy — bill ids are unguessable,
 * which matters because the id is the Mini App's only handle on a bill, and
 * knowing one is the only way to ask the API for a bill that isn't yours.
 */
export function newBillId(): string {
  return randomBytes(9).toString('base64url'); // 9 bytes -> exactly 12 chars
}

/** Charset Telegram permits in a `start` payload: A-Z a-z 0-9 _ - */
const BILL_ID_RE = /^[A-Za-z0-9_-]{12}$/;

export function isBillId(value: unknown): value is string {
  return typeof value === 'string' && BILL_ID_RE.test(value);
}

/**
 * Parses a `/start` payload of the form `<billId>-<shareIdx>`.
 * Returns null for anything malformed — an expired or hand-typed link should
 * produce a friendly message, not a 500.
 */
export function parseStartPayload(payload: string): { billId: string; shareIdx: number } | null {
  // billId itself may contain '-', so split on the LAST hyphen.
  const cut = payload.lastIndexOf('-');
  if (cut <= 0) return null;
  const billId = payload.slice(0, cut);
  const rawIdx = payload.slice(cut + 1);
  if (!isBillId(billId)) return null;
  if (!/^\d{1,2}$/.test(rawIdx)) return null;
  return { billId, shareIdx: Number(rawIdx) };
}
