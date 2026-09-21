/**
 * Money helpers. Integer minor units in, strings out — nothing here returns a
 * float.
 *
 * Every field named `cents` elsewhere in this codebase predates multi-currency
 * support and keeps its name for that reason, but it holds the bill's
 * *currency's* minor unit, not necessarily a cent — for SGD, USD, EUR and
 * friends that's the same thing, but for JPY, KRW, VND and IDR there is no
 * minor unit in practical use, so the "cents" value for those currencies is
 * the whole-unit amount itself. See shared/currency.ts for `minorDigits`.
 */
import { currencyInfo, DEFAULT_CURRENCY } from './currency.ts';

/** 1785 -> "17.85" at minorDigits=2; 1785 -> "1785" at minorDigits=0. */
export function centsToPlain(cents: number, minorDigits: 0 | 2 = 2): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  if (minorDigits === 0) return `${negative ? '-' : ''}${abs}`;
  const scale = 10 ** minorDigits;
  const whole = Math.floor(abs / scale);
  const remainder = abs % scale;
  return `${negative ? '-' : ''}${whole}.${String(remainder).padStart(minorDigits, '0')}`;
}

/**
 * 1785, "SGD" -> "$17.85". 500, "JPY" -> "¥500". Defaults to SGD so the many
 * call sites that predate multi-currency support keep compiling and behaving
 * exactly as before.
 */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY): string {
  const info = currencyInfo(currency);
  return `${info.symbol}${centsToPlain(cents, info.minorDigits)}`;
}

/**
 * "17.85" | "17,85" | "$17.85" | "17" -> 1785. Returns null on garbage.
 * Used for the Mini App's price-correction inputs, which are free text.
 *
 * Parses the digits directly rather than doing `Number(x) * 100`. That multiply
 * looks harmless but reintroduces exactly the floating-point error the
 * integer-cents invariant exists to avoid: `1.005 * 100` is
 * 100.49999999999999, which rounds to 100 and quietly loses a cent.
 *
 * `minorDigits` matches the field being parsed into — pass the currency's own
 * value (see shared/currency.ts) so a JPY total typed as "1500" doesn't turn
 * into ¥15.
 */
export function parseCents(input: string, minorDigits: 0 | 2 = 2): number | null {
  if (minorDigits === 0) {
    // This currency's minor unit doesn't exist, so a comma here is always
    // thousands-grouping punctuation ("3,270"), never a decimal separator —
    // dropped from the allowed-character set entirely, rather than reusing
    // the 2-decimal path's "convert the first comma to a decimal point"
    // cleanup below, which would read "3,270" as "3.270" and keep only the
    // leading "3". A genuine decimal point is still where the digits end —
    // anything after it is noise (a stray "." from a fumbled keyboard)
    // rather than a value to round.
    const cleaned = input.replace(/[^0-9.-]/g, '');
    if (!cleaned || cleaned.length > 20) return null;
    const match = /^(-?)(\d+)/.exec(cleaned);
    if (!match) return null;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) return null;
    return match[1] === '-' ? -value : value;
  }

  const cleaned = input.replace(/[^0-9.,-]/g, '').replace(',', '.');
  if (!cleaned || cleaned.length > 20) return null;

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;

  const sign = match[1];
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  if (whole === '' && frac === '') return null; // bare "." or "-"

  const scale = 10 ** minorDigits;
  let value = Number(whole || '0') * scale + Number(`${frac}${'0'.repeat(minorDigits)}`.slice(0, minorDigits));

  // Round half up on the digit just past the minor unit, rather than
  // truncating, so a badly-OCR'd "0.005" becomes 1 cent instead of vanishing.
  const firstDropped = frac[minorDigits];
  if (firstDropped !== undefined && Number(firstDropped) >= 5) value += 1;

  if (!Number.isFinite(value)) return null;
  return sign === '-' ? -value : value;
}

/** Guard for values that crossed a network boundary claiming to be cents. */
export function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}
