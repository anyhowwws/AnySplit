import type { Bill, Receipt, Unit } from './types.ts';

/** The id given to a bill's first receipt, and to the one a legacy bill is read as. */
export const FIRST_RECEIPT_ID = 'r0';

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
