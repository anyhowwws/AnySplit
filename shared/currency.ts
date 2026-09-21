/**
 * Currencies AnySplit can read off a receipt and display back.
 *
 * A fixed allowlist rather than accepting any ISO 4217 code the model
 * produces: `RECEIPT_TOOL`'s schema enums against `SUPPORTED_CURRENCY_CODES`
 * (see vision.ts), so a currency reaching the rest of the system is always one
 * we know how to format. Anything the model can't place lands as `SGD` — the
 * common case and, for a Singapore-based bot, the safest default when a
 * receipt is ambiguous rather than genuinely foreign.
 */
export interface CurrencyInfo {
  /** Printed before the amount. "$17.85", not "17.85 SGD". */
  symbol: string;
  /**
   * How many of this currency's minor units make a whole one. 2 for cents,
   * dollars, etc; 0 for currencies with no minor unit in practical use (JPY,
   * KRW, VND, IDR) — there, the integer *is* the amount, unscaled.
   *
   * Per ISO 4217, not a rounding convenience: money.ts's "cents" are actually
   * this currency's minor units throughout, and a 0-digit currency simply has
   * none.
   */
  minorDigits: 0 | 2;
  /**
   * What to call the tax line on a receipt in this currency. "GST" is
   * accurate for Singapore; everywhere else it would be naming a specific tax
   * that may not be the one printed (SST, VAT, consumption tax, sales tax),
   * so it falls back to the generic term.
   */
  taxLabel: string;
}

export const DEFAULT_CURRENCY = 'SGD';

/**
 * Currencies likely to show up on a receipt someone in or travelling from
 * Singapore photographs. Extending this list is safe and additive — nothing
 * elsewhere hardcodes its length or order.
 */
export const CURRENCIES: Record<string, CurrencyInfo> = {
  SGD: { symbol: '$', minorDigits: 2, taxLabel: 'GST' },
  USD: { symbol: 'US$', minorDigits: 2, taxLabel: 'Tax' },
  MYR: { symbol: 'RM', minorDigits: 2, taxLabel: 'Tax' },
  THB: { symbol: '฿', minorDigits: 2, taxLabel: 'Tax' },
  IDR: { symbol: 'Rp', minorDigits: 0, taxLabel: 'Tax' },
  JPY: { symbol: '¥', minorDigits: 0, taxLabel: 'Tax' },
  KRW: { symbol: '₩', minorDigits: 0, taxLabel: 'Tax' },
  CNY: { symbol: 'RMB', minorDigits: 2, taxLabel: 'Tax' },
  HKD: { symbol: 'HK$', minorDigits: 2, taxLabel: 'Tax' },
  TWD: { symbol: 'NT$', minorDigits: 2, taxLabel: 'Tax' },
  VND: { symbol: '₫', minorDigits: 0, taxLabel: 'Tax' },
  PHP: { symbol: '₱', minorDigits: 2, taxLabel: 'Tax' },
  GBP: { symbol: '£', minorDigits: 2, taxLabel: 'Tax' },
  EUR: { symbol: '€', minorDigits: 2, taxLabel: 'Tax' },
  AUD: { symbol: 'A$', minorDigits: 2, taxLabel: 'Tax' },
};

export const SUPPORTED_CURRENCY_CODES = Object.keys(CURRENCIES);

/**
 * `Object.hasOwn`, not `in` — `in` walks the prototype chain, so `"toString"`,
 * `"constructor"`, `"hasOwnProperty"` and every other `Object.prototype`
 * member would otherwise read as a supported currency. Reached from a client
 * body on `PATCH /api/bills/:id`, so this has to reject those the same as any
 * other bad code, not just the ones that happen to not collide with a
 * built-in property name.
 */
export function isSupportedCurrency(code: unknown): code is string {
  return typeof code === 'string' && Object.hasOwn(CURRENCIES, code);
}

/**
 * Falls back to the default currency's info — never throws on a bad code.
 *
 * `Object.hasOwn` here too: `CURRENCIES[code] ?? CURRENCIES[DEFAULT_CURRENCY]`
 * looks like a safe fallback, but for a prototype property name `CURRENCIES[code]`
 * resolves to the inherited method itself (e.g. `CURRENCIES.toString`), which is
 * truthy — so `??` never fires and callers destructure `.symbol` etc. off a
 * function instead of falling back to SGD.
 */
export function currencyInfo(code: string): CurrencyInfo {
  return Object.hasOwn(CURRENCIES, code) ? CURRENCIES[code]! : CURRENCIES[DEFAULT_CURRENCY]!;
}
