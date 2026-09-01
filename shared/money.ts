/**
 * Money helpers. Cents in, strings out — nothing here returns a float.
 */

/** 1785 -> "17.85". No currency symbol; callers add "$". */
export function centsToPlain(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${negative ? '-' : ''}${dollars}.${String(remainder).padStart(2, '0')}`;
}

/** 1785 -> "$17.85". */
export function formatCents(cents: number): string {
  return `$${centsToPlain(cents)}`;
}

/**
 * "17.85" | "17,85" | "$17.85" | "17" -> 1785. Returns null on garbage.
 * Used for the Mini App's price-correction inputs, which are free text.
 *
 * Parses the digits directly rather than doing `Number(x) * 100`. That multiply
 * looks harmless but reintroduces exactly the floating-point error the
 * integer-cents invariant exists to avoid: `1.005 * 100` is
 * 100.49999999999999, which rounds to 100 and quietly loses a cent.
 */
export function parseCents(input: string): number | null {
  const cleaned = input.replace(/[^0-9.,-]/g, '').replace(',', '.');
  if (!cleaned || cleaned.length > 20) return null;

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;

  const sign = match[1];
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  if (whole === '' && frac === '') return null; // bare "." or "-"

  let value = Number(whole || '0') * 100 + Number(`${frac}00`.slice(0, 2));

  // Round half up on the third decimal rather than truncating, so a badly-OCR'd
  // "0.005" becomes 1 cent instead of vanishing.
  const third = frac[2];
  if (third !== undefined && Number(third) >= 5) value += 1;

  if (!Number.isFinite(value)) return null;
  return sign === '-' ? -value : value;
}

/** Guard for values that crossed a network boundary claiming to be cents. */
export function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}
