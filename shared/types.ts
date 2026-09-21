import type { Payee, StoredPayee } from './payee.ts';

/**
 * Shared types between the backend Lambdas and the Mini App.
 *
 * INVARIANT: every monetary value in this file is an integer number of cents.
 * There are no floats anywhere except `factor`, which is a ratio, not money.
 */

export type BillStatus =
  | 'parsing' // enqueued, vision call in flight
  | 'review' // parsed, awaiting admin confirmation in the Mini App
  | 'final' // shares computed and sent
  | 'error'; // parse failed; `note` explains why

/**
 * One *unit* of a line item. Quantities are expanded: `2x Beer $12.00` becomes
 * two units of 600 cents each, so splitting one of two beers needs no fractions.
 */
export interface Unit {
  /** Stable id, unique within the bill. e.g. "u3". */
  id: string;
  /** Item name exactly as printed on the receipt. */
  name: string;
  /** Expanded, human-readable name. "TRFL FRS" -> "Truffle Fries". */
  displayName: string;
  /** Price of this single unit, in cents. */
  cents: number;
  /** Model's guess that this is a shared dish (rice, sides, appetisers). */
  shared: boolean;
}

/** One person's slice of the bill. Populated on finalise. */
export interface Share {
  /** Index into the bill's `shares` array. Used in the deep-link payload. */
  idx: number;
  name: string;
  /** Units this person is on the hook for. May overlap with other shares. */
  unitIds: string[];
  /** Final amount owed, in cents, tax-inclusive and cent-reconciled. */
  cents: number;
}

export interface Bill {
  /** 12-char base64url id. e.g. "aK9x2mQp7Lz4". */
  billId: string;
  /** Telegram user_id of the payer. The only user allowed to mutate this bill. */
  adminId: number;
  merchant: string;
  /**
   * ISO 4217 code, e.g. "SGD", "JPY". Always present — defaults to "SGD" for
   * bills created before multi-currency support, and for the placeholder bill
   * written before the vision call has read anything.
   */
  currency: string;
  /** Sum of all units, in cents (the bill's currency's minor unit; see money.ts). */
  subtotal: number;
  /** Amount actually payable, in cents. Includes service charge and GST. */
  total: number;
  /**
   * total / subtotal. Derived, never hardcoded. Applied to each person's item
   * sum, this handles service-charge-then-GST stacking, GST-only venues,
   * hawker receipts with neither, and flat discounts, with zero branching.
   */
  factor: number;
  status: BillStatus;
  units: Unit[];
  shares: Share[];
  /** Unix epoch SECONDS. Re-checked on read; expired items are treated absent. */
  ttl: number;
  /** Service charge in cents, as printed. Informational only. */
  serviceCharge?: number;
  /** GST in cents, as printed. Informational only. */
  gst?: number;
  /** Discount in cents, as printed, positive. Already deducted from `total`. */
  discount?: number;
  /** Human-readable note surfaced in the UI (parse warnings, errors). */
  note?: string;
  /**
   * Who to pay back — name only; see StoredPayee for why no phone number.
   * Absent when the admin didn't specify one.
   */
  payee?: StoredPayee;
}

/* ---------- Vision model output ---------- */

/** The shape the vision model must return, enforced by a strict tool schema. */
export interface ParsedReceipt {
  merchant: string;
  /** ISO 4217 code the model read off the receipt; "SGD" when it can't tell. */
  currency: string;
  items: ParsedItem[];
  subtotalCents: number;
  serviceChargeCents: number;
  gstCents: number;
  /** Positive number; already deducted from totalCents. */
  discountCents: number;
  totalCents: number;
}

export interface ParsedItem {
  rawName: string;
  displayName: string;
  qty: number;
  unitPriceCents: number;
  isLikelyShared: boolean;
}

/* ---------- Mini App <-> API wire types ---------- */

/** GET /api/bills/:id */
export interface GetBillResponse {
  bill: Bill;
  /** Bot username, so the Mini App can render deep links. */
  botUsername: string;
}

/** PATCH /api/bills/:id — all fields optional; only what changed is sent. */
export interface PatchBillRequest {
  merchant?: string;
  /** ISO 4217 code. Must be one of shared/currency.ts's supported list. */
  currency?: string;
  total?: number;
  units?: Unit[];
}

/**
 * How the admin wants the result delivered.
 *
 * `personal` — one message per person, forwarded individually.
 * `group`    — everyone in a single message, pasted into a group chat.
 */
export type SendMode = 'personal' | 'group';

/** POST /api/bills/:id/finalise */
export interface FinaliseRequest {
  people: { name: string; unitIds: string[] }[];
  /** Optional. Dropped silently if the name is blank. */
  payee?: Payee;
  /** Defaults to `personal` when absent. */
  mode?: SendMode;
}

export interface FinaliseResponse {
  shares: Share[];
}

export interface ApiError {
  error: string;
}
