import type { ParsedReceipt, Unit } from '../../../shared/types.ts';
import { deriveFactor, expandUnits, reconcilesToSubtotal, subtotalOf, summaryDelta } from './calc.ts';
import { formatCents } from './money.ts';

/**
 * Turns a parsed receipt into the fields a bill stores.
 *
 * Extracted so the parser Lambda and the /test fixtures share one
 * implementation. A mock that computed its own totals would drift from the real
 * thing and quietly stop being a useful test.
 */
export interface DerivedBill {
  merchant: string;
  subtotal: number;
  total: number;
  factor: number;
  units: Unit[];
  serviceCharge: number;
  gst: number;
  discount: number;
  /** Warning text when either validation gate fails; undefined when both pass. */
  note?: string;
}

export function deriveBill(receipt: ParsedReceipt): DerivedBill {
  const units = expandUnits(receipt);

  // The subtotal we store is the sum of the units we're actually going to
  // distribute — not the receipt's printed subtotal. factor must be relative to
  // what gets divided up, or the shares won't add to the total.
  const subtotal = subtotalOf(units);
  const total = receipt.totalCents;
  const factor = deriveFactor(subtotal, total);

  // Two independent gates. On mismatch the parse still lands, flagged, so the
  // admin can fix it in the Review screen — we never silently proceed with
  // numbers that don't reconcile.
  const warnings: string[] = [];

  if (!reconcilesToSubtotal(receipt)) {
    warnings.push(
      `The items add up to ${formatCents(subtotal)} but the receipt's subtotal reads ` +
        `${formatCents(receipt.subtotalCents)}.`,
    );
  }

  // Catches a total the model never actually saw — e.g. when the summary block
  // is out of frame and it fills the field in from nothing.
  const delta = summaryDelta(receipt);
  if (delta !== 0) {
    warnings.push(
      `The total doesn't match the charges: ${formatCents(receipt.subtotalCents)} ` +
        `${receipt.discountCents ? `− ${formatCents(receipt.discountCents)} ` : ''}` +
        `${receipt.serviceChargeCents ? `+ ${formatCents(receipt.serviceChargeCents)} ` : ''}` +
        `${receipt.gstCents ? `+ ${formatCents(receipt.gstCents)} ` : ''}` +
        `should be ${formatCents(receipt.totalCents - delta)}, but the total reads ` +
        `${formatCents(receipt.totalCents)}.`,
    );
  }

  return {
    merchant: receipt.merchant,
    subtotal,
    total,
    factor,
    units,
    serviceCharge: receipt.serviceChargeCents,
    gst: receipt.gstCents,
    discount: receipt.discountCents,
    note: warnings.length > 0 ? `${warnings.join(' ')} Check before splitting.` : undefined,
  };
}
