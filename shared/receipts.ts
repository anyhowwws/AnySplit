import type { Bill, Receipt, ReceiptStatus, Unit } from './types.ts';

/** The id given to a bill's first receipt, and to the one a legacy bill is read as. */
export const FIRST_RECEIPT_ID = 'r0';

/**
 * How many receipts one bill can hold. A long night, not a week's expenses —
 * and each is a vision call, plus room in a 400KB DynamoDB item.
 */
export const MAX_RECEIPTS = 8;

/** A receipt's status, reading an absent one as `review` (see Receipt.status). */
export function statusOf(receipt: Receipt): ReceiptStatus {
  return receipt.status ?? 'review';
}

/** Receipts whose items are ready to split. */
export function readyReceipts(bill: Pick<Bill, 'receipts'>): Receipt[] {
  return receiptsOf(bill).filter((receipt) => statusOf(receipt) === 'review');
}

/**
 * Why this bill can't be split yet, in words for the admin, or null when it
 * can. The server refuses to finalise on the same grounds, and the Mini App
 * shows the same words before anyone gets that far.
 */
export function splitBlocker(receipts: Receipt[]): string | null {
  const reading = receipts.filter((r) => statusOf(r) === 'parsing').length;
  if (reading > 0) {
    return reading === 1
      ? "One receipt is still being read. Give it a moment."
      : `${reading} receipts are still being read. Give them a moment.`;
  }
  if (receipts.some((r) => statusOf(r) === 'error')) {
    return "Remove the receipt I couldn't read before splitting.";
  }
  // Amounts in two currencies can't be added up, and converting them would
  // need the rate the payer's card actually used — which only they have.
  const currencies = [...new Set(receipts.map((r) => r.currency))];
  if (currencies.length > 1) {
    return (
      `These receipts are in different currencies (${currencies.join(', ')}). ` +
      'A bill is split in one — fix a misread currency, or remove the receipt.'
    );
  }
  return null;
}

/** A bill's receipts in the order they were photographed. */
export function receiptsOf(bill: Pick<Bill, 'receipts'>): Receipt[] {
  return Object.values(bill.receipts).sort((a, b) => a.seq - b.seq);
}

/** Every unit on the bill, across all its receipts, in receipt order. */
export function allUnits(bill: Pick<Bill, 'receipts'>): Unit[] {
  return receiptsOf(bill).flatMap((receipt) => receipt.units);
}

/**
 * The bill's one receipt.
 *
 * Every caller is a place that still assumes one receipt per bill — the
 * messages, the Review screen — and needs revisiting once a bill can hold
 * several. Throwing rather than quietly taking the first keeps that from
 * silently dropping a receipt's items from somebody's total.
 */
export function onlyReceipt(bill: Pick<Bill, 'receipts'>): Receipt {
  const receipts = receiptsOf(bill);
  if (receipts.length !== 1) {
    throw new Error(`expected exactly one receipt, found ${receipts.length}`);
  }
  return receipts[0]!;
}
