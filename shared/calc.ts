import type { ParsedReceipt, Share, Unit } from './types.ts';

export interface PersonAssignment {
  name: string;
  unitIds: string[];
}

export class CalcError extends Error {}

/** Sum of every unit. This, not the receipt's printed subtotal, is the base. */
export function subtotalOf(units: Unit[]): number {
  return units.reduce((sum, u) => sum + u.cents, 0);
}

/**
 * The grossing factor: total / subtotal.
 *
 * Derived, never hardcoded. Applied to each person's item sum it handles
 * service-charge-then-GST stacking, GST-only venues, hawker receipts with
 * neither, and flat discounts, with zero branching. A 10% service charge plus
 * 9% GST is simply factor = 1.199.
 */
export function deriveFactor(subtotal: number, total: number): number {
  if (subtotal <= 0) return 1;
  return total / subtotal;
}

/** Expands `qty` into individual units. `2x Beer $12.00` -> two 600c units. */
export function expandUnits(receipt: ParsedReceipt): Unit[] {
  const units: Unit[] = [];
  let seq = 0;
  for (const item of receipt.items) {
    const qty = Math.max(1, Math.trunc(item.qty));
    for (let i = 0; i < qty; i++) {
      units.push({
        id: `u${seq++}`,
        name: item.rawName,
        displayName: item.displayName || item.rawName,
        cents: item.unitPriceCents,
        shared: item.isLikelyShared,
      });
    }
  }
  return units;
}

/**
 * Cents belonging to units nobody has claimed. The Mini App surfaces this as a
 * sticky "unassigned: $X.XX" bar and blocks finalisation while it is non-zero —
 * an unclaimed unit would otherwise silently vanish from everyone's total.
 */
export function unassignedCents(units: Unit[], people: PersonAssignment[]): number {
  const claimed = new Set<string>();
  for (const person of people) for (const id of person.unitIds) claimed.add(id);
  return units.filter((u) => !claimed.has(u.id)).reduce((sum, u) => sum + u.cents, 0);
}

/**
 * Per-person totals, tax included, cents reconciled.
 *
 *   base   = sum over claimed units of unitCents / claimCount(unit)
 *   raw    = base * factor
 *   shares = round(raw), with the 1-2 cent rounding delta added to the largest
 *
 * Rounding each person independently leaves the sum a cent or two off the real
 * total. Handing that delta to the largest share keeps everyone's number
 * plausible and makes the shares add up to exactly what was paid.
 *
 * Throws if any unit is unclaimed — the reconciliation step is only meaningful
 * when the shares are supposed to sum to `total`.
 */
export function computeShares(
  units: Unit[],
  factor: number,
  total: number,
  people: PersonAssignment[],
): Share[] {
  if (people.length === 0) throw new CalcError('no people to split between');

  const unitById = new Map(units.map((u) => [u.id, u]));

  // How many people share each unit. Duplicate ids within one person count once.
  const claimCount = new Map<string, number>();
  const deduped = people.map((p) => ({ name: p.name, unitIds: [...new Set(p.unitIds)] }));
  for (const person of deduped) {
    for (const id of person.unitIds) {
      if (!unitById.has(id)) throw new CalcError(`unknown unit id: ${id}`);
      claimCount.set(id, (claimCount.get(id) ?? 0) + 1);
    }
  }

  const unclaimed = units.filter((u) => !claimCount.has(u.id));
  if (unclaimed.length > 0) {
    throw new CalcError(`${unclaimed.length} unit(s) unassigned`);
  }

  const raw = deduped.map((person) =>
    person.unitIds.reduce((sum, id) => {
      const unit = unitById.get(id)!;
      return sum + unit.cents / claimCount.get(id)!;
    }, 0) * factor,
  );

  const rounded = raw.map((value) => Math.round(value));

  // Reconcile: hand the rounding remainder to the biggest share.
  const sum = rounded.reduce((a, b) => a + b, 0);
  const delta = total - sum;
  if (delta !== 0) {
    let maxIdx = 0;
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i]! > rounded[maxIdx]!) maxIdx = i;
    }
    rounded[maxIdx] = rounded[maxIdx]! + delta;
  }

  return deduped.map((person, idx) => ({
    idx,
    name: person.name,
    unitIds: person.unitIds,
    cents: rounded[idx]!,
  }));
}

/**
 * Validation gate on the model's output: the items must add up to the printed
 * subtotal. On mismatch we still show the parse, but flagged for review — the
 * admin fixes it in the Mini App rather than us silently proceeding with
 * numbers that don't reconcile.
 */
export function reconcilesToSubtotal(receipt: ParsedReceipt): boolean {
  const itemSum = receipt.items.reduce(
    (sum, item) => sum + Math.max(1, Math.trunc(item.qty)) * item.unitPriceCents,
    0,
  );
  return itemSum === receipt.subtotalCents;
}

/**
 * Receipts frequently round the final total to the nearest 5 cents, and the
 * adjustment is rarely printed as its own line. Anything inside this is
 * rounding, not a misread.
 */
const SUMMARY_TOLERANCE_CENTS = 5;

/**
 * Second validation gate: the summary block must be internally consistent.
 *
 *   subtotal − discount + service charge + GST == total
 *
 * `reconcilesToSubtotal` only proves the *items* were read correctly; it never
 * looks at the total. That gap let a receipt whose totals block had been cropped
 * out of frame pass as "reconciled" while the model quietly invented a total —
 * twice, differently, from the same photo. This checks the number people
 * actually pay.
 *
 * Returns the signed discrepancy in cents; 0 means it balances.
 */
export function summaryDelta(receipt: ParsedReceipt): number {
  const expected =
    receipt.subtotalCents -
    receipt.discountCents +
    receipt.serviceChargeCents +
    receipt.gstCents;
  const delta = receipt.totalCents - expected;
  return Math.abs(delta) <= SUMMARY_TOLERANCE_CENTS ? 0 : delta;
}
