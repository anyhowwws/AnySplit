import type { ParsedItem, ParsedReceipt } from '../../../shared/types.ts';

/**
 * Canned receipts for /test, so the whole flow can be exercised without sending
 * a photo — and therefore without paying for a vision call on every iteration.
 *
 * These are fed through the same `deriveBill` the parser uses, so they exercise
 * the real expansion, factor derivation, and both validation gates. Only the
 * model call is skipped.
 *
 * Each fixture targets a path that is otherwise awkward to reach on demand: you
 * cannot conjure a hawker chit with no GST, or a receipt whose totals disagree,
 * exactly when you want to test one.
 */

function item(
  displayName: string,
  unitPriceCents: number,
  qty = 1,
  isLikelyShared = false,
): ParsedItem {
  return { rawName: displayName, displayName, qty, unitPriceCents, isLikelyShared };
}

export interface Fixture {
  /** What this exercises, shown when the command is called with no argument. */
  description: string;
  receipt: ParsedReceipt;
}

export const FIXTURES: Record<string, Fixture> = {
  /* The ordinary case: 10% service then 9% GST, everything reconciles. */
  simple: {
    description: 'restaurant, 10% service + 9% GST, everything balances',
    receipt: {
      merchant: 'Le Shrimp Noodle Bar',
      items: [
        item('Prawn Dumpling Noodle', 1560),
        item('Signature La Mian', 1420),
        item('Bottled Water', 250, 2),
        item('Century Egg Congee', 980, 1, true),
      ],
      subtotalCents: 4460,
      serviceChargeCents: 446,
      gstCents: 442,
      discountCents: 0,
      totalCents: 5348,
    },
  },

  /* No tax at all — factor lands on exactly 1.0, and the charge line is omitted. */
  hawker: {
    description: 'hawker stall, no service charge and no GST (factor 1.0)',
    receipt: {
      merchant: 'Tiong Bahru Hainanese Chicken',
      items: [
        item('Chicken Rice', 450, 2),
        item('Kopi O', 160),
        item('Bean Sprouts', 350, 1, true),
      ],
      subtotalCents: 1410,
      serviceChargeCents: 0,
      gstCents: 0,
      discountCents: 0,
      totalCents: 1410,
    },
  },

  /* Discount before charges — total lands BELOW the item sum, factor < 1. */
  discount: {
    description: '20% discount, then service + GST (total below item sum)',
    receipt: {
      merchant: 'Shin Katsu',
      items: [
        item('Kurobuta Rosu Katsu Set', 3580, 2),
        item('Mille-Feuille Katsu Set', 3080),
        item('Green Tea', 150, 2, true),
      ],
      subtotalCents: 10540,
      serviceChargeCents: 843,
      gstCents: 834,
      discountCents: 2108,
      totalCents: 10109,
    },
  },

  /* GST but no service charge — the charge line should name GST only. */
  gstonly: {
    description: '9% GST, no service charge',
    receipt: {
      merchant: 'Cedele Bakery',
      items: [item('Flat White', 620), item('Avocado Toast', 1480), item('Carrot Cake Slice', 780)],
      subtotalCents: 2880,
      serviceChargeCents: 0,
      gstCents: 259,
      discountCents: 0,
      totalCents: 3139,
    },
  },

  /* Items deliberately don't add up: triggers the warning banner and the
     "Fix the numbers & split" button instead of "Review & split". */
  mismatch: {
    description: "items don't match the printed subtotal — triggers the warning",
    receipt: {
      merchant: 'Faded Thermal Cafe',
      items: [item('Spicy Mala Popcorn Chicken', 1690), item('Truffle Cheese Fries', 1590)],
      // Printed subtotal disagrees with the items above by $8.00, exactly the
      // kind of misread the gate exists to catch.
      subtotalCents: 2480,
      serviceChargeCents: 248,
      gstCents: 246,
      discountCents: 0,
      totalCents: 2974,
    },
  },

  /* Long receipt with plenty of shared dishes — for the group message, the
     shared-dish shortcut, and the consolidated overflow guard. */
  big: {
    description: '12 lines, 17 units, 5 shared — good for the group message',
    receipt: {
      merchant: "Harry's @ Robertson Quay",
      items: [
        item('Chicken Quesadillas', 1700, 1, true),
        item('Herb-Marinated Tomapork', 2900, 2),
        item('Seaweed Prawn Aglio Olio', 2600),
        item('Beer-Battered Fish and Chips', 2600),
        item('Roasted Garden Vegetables', 1900, 1, true),
        item('Guinness Pint', 1700, 3),
        item('Heineken Pint', 1600),
        item('Kirin Pint', 1600, 2),
        item('Coke Can', 600, 2),
        item('Truffle Fries', 1200, 1, true),
        item('Chicken Satay 8pcs', 1600, 1, true),
        item('Crispy Chicken Skin', 1100, 1, true),
      ],
      subtotalCents: 29600,
      serviceChargeCents: 2960,
      gstCents: 2930,
      discountCents: 0,
      totalCents: 35490,
    },
  },

  /* Items and subtotal agree, but the total doesn't match the charges — the
     signature of a total the model invented because it couldn't see one. Trips
     the second gate only, where `mismatch` trips the first. */
  badtotal: {
    description: "total doesn't match the charges — the 'invented total' gate",
    receipt: {
      merchant: 'Cut-Off Corner Bistro',
      items: [item('Ribeye', 4200), item('House Red', 1400, 2)],
      subtotalCents: 7000,
      serviceChargeCents: 700,
      gstCents: 693,
      discountCents: 0,
      // 7000 + 700 + 693 = 8393, so this is $6.07 adrift.
      totalCents: 9000,
    },
  },
};

export function fixtureNames(): string[] {
  return Object.keys(FIXTURES);
}
