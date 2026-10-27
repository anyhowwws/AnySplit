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
  /**
   * `cents` broken down by receiptId; each entry reconciles with the other
   * people's against that receipt's total. Absent on shares written before
   * bills could hold several receipts, which only ever had one.
   */
  byReceipt?: Record<string, number>;
}

/**
 * Where one receipt is in its own life, independent of the bill's.
 *
 * `parsing` — its photo is still being read.
 * `review`  — read; its items are ready to check and split.
 * `error`   — couldn't be read; `note` says why. Has no items, and blocks
 *             sending until it's removed.
 */
export type ReceiptStatus = 'parsing' | 'review' | 'error';

/**
 * One photographed receipt. A bill holds one or more of these, and each is
 * split on its own before the results are summed per person — service charge
 * and tax don't stack the same way on every receipt, so pooling their items
 * under one `factor` would overcharge some people and undercharge others.
 */
export interface Receipt {
  /**
   * Stable id, unique within the bill and never reused — "r0" for the first,
   * random after that, so a parse still in flight for a removed receipt can't
   * land in a later one. Prefixes its units' ids.
   */
  receiptId: string;
  /** Absent on receipts written before this field existed: they were all read. */
  status?: ReceiptStatus;
  /** Display order: the order the photos arrived in. */
  seq: number;
  merchant: string;
  /**
   * ISO 4217 code, e.g. "SGD", "JPY". Always present — defaults to "SGD" for
   * bills created before multi-currency support, and for the placeholder bill
   * written before the vision call has read anything.
   */
  currency: string;
  /** Sum of all units, in cents (the receipt's currency's minor unit; see money.ts). */
  subtotal: number;
  /** Amount actually payable, in cents. Includes service charge and GST. */
  total: number;
  /**
   * total / subtotal. Derived, never hardcoded. Applied to each person's item
   * sum, this handles service-charge-then-GST stacking, GST-only venues,
   * hawker receipts with neither, and flat discounts, with zero branching.
   */
  factor: number;
  units: Unit[];
  /** Service charge in cents, as printed. Informational only. */
  serviceCharge?: number;
  /** GST in cents, as printed. Informational only. */
  gst?: number;
  /** Discount in cents, as printed, positive. Already deducted from `total`. */
  discount?: number;
  /** Parse warnings, or why the parse failed, surfaced in the Mini App. */
  note?: string;
}

export interface Bill {
  /** 12-char base64url id. e.g. "aK9x2mQp7Lz4". */
  billId: string;
  /** Telegram user_id of the payer. The only user allowed to mutate this bill. */
  adminId: number;
  /**
   * Keyed by receiptId. A map rather than a list so that, once a bill can
   * hold several receipts, each parse can write its own entry without
   * overwriting a sibling that finished at the same moment. Read through
   * `receiptsOf` (shared/receipts.ts) for display order.
   */
  receipts: Record<string, Receipt>;
  status: BillStatus;
  shares: Share[];
  /** Unix epoch SECONDS. Re-checked on read; expired items are treated absent. */
  ttl: number;
  /** Why the first receipt's parse failed, when `status` is `error`. */
  note?: string;
  /**
   * Who to pay back — name only; see StoredPayee for why no phone number.
   * Absent when the admin didn't specify one. When several people paid,
   * the first of `payers`; read the whole picture through `paymentOf`
   * (shared/settle.ts).
   */
  payee?: StoredPayee;
  /** Everyone who paid a receipt — names only, as `payee`. Set on finalise. */
  payers?: StoredPayee[];
  /** receiptId -> index into `payers`: who paid each receipt. */
  paidBy?: Record<string, number>;
}

/* ---------- Vision model output ---------- */

/** The shape the vision model must return, enforced by a strict tool schema. */
export interface ParsedReceipt {
  merchant: string;
  /** ISO 4217 code the model read off the receipt; "SGD" when it can't tell. */
  currency: string;
  /**
   * False when `currency` is a guess — an ambiguous symbol, a currency outside
   * the supported list, or a value vision.ts had to replace. Surfaced as a
   * `note` so the payer checks it. Absent (the /test fixtures) means confident.
   */
  currencyConfident?: boolean;
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

/**
 * PATCH /api/bills/:id — edits one receipt. All fields optional; only what
 * changed is sent.
 */
export interface PatchBillRequest {
  /** Which receipt. May be omitted while the bill has exactly one. */
  receiptId?: string;
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
  /**
   * Optional. Dropped silently if the name is blank. With one payer for the
   * whole bill this is all a client needs to send; superseded by `payers`.
   */
  payee?: Payee;
  /**
   * Everyone who paid a receipt, when that's more than one person. Every
   * name must be filled in, and no person may appear twice.
   */
  payers?: Payee[];
  /** receiptId -> index into `payers`, for every receipt. Required with `payers`. */
  paidBy?: Record<string, number>;
  /** Defaults to `personal` when absent. */
  mode?: SendMode;
}

export interface FinaliseResponse {
  shares: Share[];
}

export interface ApiError {
  error: string;
}
