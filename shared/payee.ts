/**
 * Who to pay back, for the common case where the person splitting the bill
 * isn't the person who actually paid it.
 *
 * Optional throughout: plenty of groups already know who fronted the money, and
 * forcing a phone number on them would be friction for no gain.
 */

/**
 * What actually gets persisted: the name, and never the phone number.
 *
 * The number is somebody's personal contact detail, frequently not even the
 * admin's own. It is needed for exactly one moment — composing the messages the
 * admin forwards — and after that it has no job. Storing it would mean holding
 * third-party contact details for the bill's whole 7-day life to no purpose, so
 * the persisted shape simply has nowhere to put one.
 */
export interface StoredPayee {
  name: string;
  /**
   * Index into the bill's shares when the payer is one of the people splitting.
   * Absent when they're an outsider — someone who covered a bill they weren't
   * part of.
   *
   * Carried as an index rather than matched on name: names are free text, two
   * people can be called Sam, and "who paid" is too load-bearing to infer from
   * a string comparison.
   */
  personIndex?: number;
}

/** Transient form, used only to compose outgoing messages. Never written down. */
export interface Payee extends StoredPayee {
  /**
   * As entered, normalised for display. Free-form rather than strictly
   * validated: this is shown to humans, not dialled by a machine, and an
   * over-strict rule would reject a legitimate overseas number.
   */
  phone: string;
}

/** Strips the phone on the way to storage. The only path into the database. */
export function toStoredPayee(payee: Payee | null): StoredPayee | null {
  if (!payee) return null;
  return payee.personIndex === undefined
    ? { name: payee.name }
    : { name: payee.name, personIndex: payee.personIndex };
}

/** Names are shown to recipients; keep them short enough to render sanely. */
export const MAX_PAYEE_NAME = 40;

/**
 * Tidies a typed phone number for display, or returns null if it can't
 * plausibly be one.
 *
 * Singapore mobiles are 8 digits, usually written "9123 4567", and the country
 * code may or may not be present. Both are accepted and normalised to the shape
 * a local would recognise; anything else legitimate-looking is passed through
 * with its digits intact rather than rejected.
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasCountryCode = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  // Loose bounds: shortest national numbers are 8 digits, E.164 caps at 15.
  if (digits.length < 8 || digits.length > 15) return null;

  // Bare Singapore mobile: 9123 4567
  if (!hasCountryCode && digits.length === 8) {
    return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  }
  // With country code: +65 9123 4567
  if (digits.startsWith('65') && digits.length === 10) {
    return `+65 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }

  return hasCountryCode ? `+${digits}` : digits;
}

/**
 * Validates and normalises a payee from untrusted input.
 *
 * Returns null when there's nothing usable — an empty name means no payee was
 * given, which is a valid state rather than an error.
 */
export function cleanPayee(input: unknown): Payee | null {
  if (typeof input !== 'object' || input === null) return null;

  const raw = input as { name?: unknown; phone?: unknown };
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_PAYEE_NAME) : '';
  if (!name) return null;

  const phone = typeof raw.phone === 'string' ? normalisePhone(raw.phone) : null;

  // Bounds are re-checked against the actual people list by the caller; this
  // only rejects values that could never be an index.
  const rawIndex = (raw as { personIndex?: unknown }).personIndex;
  const personIndex =
    typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
      ? rawIndex
      : undefined;

  return { name, phone: phone ?? '', personIndex };
}
