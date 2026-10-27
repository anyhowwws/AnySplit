import type { Payee } from '../../../shared/payee.ts';
import type { Payment } from '../../../shared/settle.ts';
import type { Bill, Receipt } from '../../../shared/types.ts';

/** Who paid a receipt: an index into the people splitting, or someone else. */
export type PayerRef = number | 'other';

/**
 * The admin's picks on the Summary screen, before they're turned into the
 * payers the API takes. Phones live here only until the send — they're never
 * stored, so a re-opened bill brings back names but not numbers.
 */
export interface PaymentDraft {
  /** Explicit picks by receiptId. A receipt not in here falls back to the default. */
  paidBy: Record<string, PayerRef>;
  /** The name for `other` — somebody who paid but isn't splitting. */
  otherName: string;
  /** By `phoneKey(ref)`. */
  phones: Record<string, string>;
}

export function phoneKey(ref: PayerRef): string {
  return String(ref);
}

/** A fresh draft: the admin's own Telegram name, as the payer of everything. */
export function newDraft(ownName: string): PaymentDraft {
  return { paidBy: {}, otherName: ownName, phones: {} };
}

/**
 * Who paid this receipt. Without an explicit pick, the admin — they usually
 * paid it themselves — matched by their Telegram name against the people
 * list, so the right chip lights up as soon as they've added themselves.
 * Unmatched, it's "someone else" with their name filled in.
 */
export function payerRef(
  draft: PaymentDraft,
  names: string[],
  receiptId: string,
  ownName: string,
): PayerRef {
  const pick = draft.paidBy[receiptId];
  if (pick === 'other' || (typeof pick === 'number' && pick < names.length)) return pick;
  const own = ownName.trim().toLowerCase();
  const index = own ? names.findIndex((name) => name.trim().toLowerCase() === own) : -1;
  return index >= 0 ? index : 'other';
}

/** The display name of a payer ref. */
export function payerName(draft: PaymentDraft, names: string[], ref: PayerRef): string {
  return ref === 'other' ? draft.otherName.trim() : (names[ref] ?? '');
}

/**
 * The payers and who paid which receipt, in the shape finalise takes. Payers
 * are listed in the order they first paid. Null when one person paid it all
 * and has no name — "no payee", which is allowed.
 */
export function buildPayment(
  draft: PaymentDraft,
  names: string[],
  receipts: Receipt[],
  ownName: string,
): Payment<Payee> | null {
  const refs = receipts.map((receipt) => payerRef(draft, names, receipt.receiptId, ownName));
  const distinct = [...new Set(refs)];
  const payers: Payee[] = distinct.map((ref) => ({
    name: payerName(draft, names, ref),
    phone: draft.phones[phoneKey(ref)] ?? '',
    personIndex: ref === 'other' ? undefined : ref,
  }));
  if (payers.length === 1 && !payers[0]!.name) return null;
  return {
    payers,
    paidBy: Object.fromEntries(
      receipts.map((receipt, i) => [receipt.receiptId, distinct.indexOf(refs[i]!)]),
    ),
  };
}

/**
 * A draft rebuilt from a bill that was already sent, so the Summary shows
 * who paid what as it was left. Names only: the phones were never stored.
 */
export function draftFromBill(bill: Bill, ownName: string): PaymentDraft {
  const draft = newDraft(ownName);
  const payers = bill.payers ?? (bill.payee ? [bill.payee] : []);
  if (payers.length === 0) return draft;
  const outsider = payers.find((payer) => payer.personIndex === undefined);
  if (outsider) draft.otherName = outsider.name;
  for (const receiptId of Object.keys(bill.receipts)) {
    const payer = payers[bill.paidBy?.[receiptId] ?? 0];
    if (payer) draft.paidBy[receiptId] = payer.personIndex ?? 'other';
  }
  return draft;
}
