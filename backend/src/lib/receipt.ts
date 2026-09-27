import type { ParsedReceipt, Unit } from '../../../shared/types.ts';
import { deriveFactor, expandUnits, reconcilesToSubtotal, subtotalOf, summaryDelta } from './calc.ts';
import { moneyFormatter } from './money.ts';

/**
 * Turns a parsed receipt into the fields a bill stores.
 *
 * Extracted so the parser Lambda and the /test fixtures share one
 * implementation. A mock that computed its own totals would drift from the real
 * thing and quietly stop being a useful test.
 */
export interface DerivedBill {
  merchant: string;
  currency: string;
  subtotal: number;
  total: number;
  factor: number;
  units: Unit[];
  serviceCharge: number;
  gst: number;
  discount: number;
  /** Warning text when any validation gate trips; undefined when all pass. */
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

  // Independent gates. When one trips the parse still lands, flagged, so the
  // admin can fix it in the Review screen — we never silently proceed with
  // numbers that don't reconcile.
  const warnings: string[] = [];
  const money = moneyFormatter(receipt.currency);

  if (!reconcilesToSubtotal(receipt)) {
    warnings.push(
      `The items add up to ${money(subtotal)} but the receipt's ` +
        `subtotal reads ${money(receipt.subtotalCents)}.`,
    );
  }

  // Catches a total the model never actually saw — e.g. when the summary block
  // is out of frame and it fills the field in from nothing.
  const delta = summaryDelta(receipt);
  if (delta !== 0) {
    warnings.push(
      `The total doesn't match the charges: ${money(receipt.subtotalCents)} ` +
        `${receipt.discountCents ? `− ${money(receipt.discountCents)} ` : ''}` +
        `${receipt.serviceChargeCents ? `+ ${money(receipt.serviceChargeCents)} ` : ''}` +
        `${receipt.gstCents ? `+ ${money(receipt.gstCents)} ` : ''}` +
        `should be ${money(receipt.totalCents - delta)}, but the total reads ` +
        `${money(receipt.totalCents)}.`,
    );
  }

  // A third gate the arithmetic can't provide: a bill in the wrong currency still
  // adds up perfectly, so nothing above would notice. The model says when it
  // guessed, and that goes through the same note as a misread number.
  if (receipt.currencyConfident === false) {
    warnings.push(
      `I couldn't tell for sure which currency this is, so it's shown in ${receipt.currency}.`,
    );
  }

  return {
    merchant: receipt.merchant,
    currency: receipt.currency,
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
