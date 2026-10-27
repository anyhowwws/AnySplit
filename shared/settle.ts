import type { StoredPayee } from './payee.ts';
import type { Bill, Share } from './types.ts';

/**
 * Who paid for what: the people who fronted money, and which of them paid
 * each receipt. `paidBy` maps receiptId -> index into `payers`.
 *
 * Generic over the payer shape so the same structure carries phones while
 * the messages are composed (Payee) and drops them when stored (StoredPayee).
 */
export interface Payment<P extends StoredPayee = StoredPayee> {
  payers: P[];
  paidBy: Record<string, number>;
}

/** Someone money moves between: a person splitting, or a payer who isn't. */
export interface Party {
  name: string;
  /** Index into the shares, when this party is one of the people splitting. */
  personIndex?: number;
  /** Index into `payers`, when this party paid any receipt. */
  payerIndex?: number;
}

/** `from` pays `to` this many cents. Both are indexes into `parties`. */
export interface Transfer {
  from: number;
  to: number;
  cents: number;
}

export interface Settlement {
  /** The people splitting, in share order, then any payer who isn't one of them. */
  parties: Party[];
  /** What each party paid across the bill's receipts. */
  paid: number[];
  /** paid − share. Positive: owed money. Negative: owes money. Sums to zero. */
  net: number[];
  transfers: Transfer[];
}

export class SettleError extends Error {}

/**
 * Who pays whom, once each receipt's payer is known.
 *
 * Each person's balance is what they paid minus their share, and the shares
 * already reconcile to the receipts' totals to the cent, so the balances sum
 * to exactly zero. Those balances then become transfers: repeatedly, whoever
 * owes most pays whoever is owed most, as much as either allows. That never
 * takes more than one transfer fewer than the number of people with a
 * balance, and usually far fewer — dinner paid by one person and drinks by
 * another settles with one transfer each from the rest, not two.
 *
 * The cost: someone may be told to pay a person whose receipt they weren't
 * on. The messages keep every person's per-receipt breakdown, so the amount
 * can always be checked against what they had.
 *
 * Ties break by index, so the same bill always settles the same way.
 */
export function settle(
  shares: Share[],
  receipts: { receiptId: string; total: number }[],
  payment: Payment,
): Settlement {
  const parties: Party[] = shares.map((share) => ({ name: share.name, personIndex: share.idx }));

  payment.payers.forEach((payer, payerIndex) => {
    const person = payer.personIndex;
    if (person !== undefined) {
      if (!parties[person]) throw new SettleError(`payer ${payerIndex} names an unknown person`);
      parties[person]!.payerIndex = payerIndex;
    } else {
      parties.push({ name: payer.name, payerIndex });
    }
  });
  const partyOfPayer = new Map(
    parties.flatMap((party, i) => (party.payerIndex === undefined ? [] : [[party.payerIndex, i]])),
  );

  const paid = parties.map(() => 0);
  for (const receipt of receipts) {
    const payerIndex = payment.paidBy[receipt.receiptId];
    const party = payerIndex === undefined ? undefined : partyOfPayer.get(payerIndex);
    if (party === undefined) throw new SettleError(`no payer for receipt ${receipt.receiptId}`);
    paid[party]! += receipt.total;
  }

  const net = parties.map(
    (party, i) => paid[i]! - (party.personIndex === undefined ? 0 : shares[party.personIndex]!.cents),
  );
  if (net.reduce((a, b) => a + b, 0) !== 0) {
    throw new SettleError('shares do not add up to what was paid');
  }

  const owed = net.map((cents, i) => ({ i, cents })).filter((p) => p.cents > 0);
  const owing = net.map((cents, i) => ({ i, cents: -cents })).filter((p) => p.cents > 0);
  const largestFirst = (a: { i: number; cents: number }, b: { i: number; cents: number }) =>
    b.cents - a.cents || a.i - b.i;

  const transfers: Transfer[] = [];
  while (owed.length > 0 && owing.length > 0) {
    owed.sort(largestFirst);
    owing.sort(largestFirst);
    const to = owed[0]!;
    const from = owing[0]!;
    const cents = Math.min(to.cents, from.cents);
    transfers.push({ from: from.i, to: to.i, cents });
    to.cents -= cents;
    from.cents -= cents;
    if (to.cents === 0) owed.shift();
    if (from.cents === 0) owing.shift();
  }

  return { parties, paid, net, transfers };
}

/**
 * A bill's stored payment, or undefined when nobody was named.
 *
 * Bills finalised before receipts could have different payers stored one
 * `payee`, who collected for everything — read here as the payer of every
 * receipt, so there's one shape to handle downstream.
 */
export function paymentOf(
  bill: Pick<Bill, 'payers' | 'paidBy' | 'payee' | 'receipts'>,
): Payment | undefined {
  if (bill.payers && bill.paidBy && bill.payers.length > 0) {
    return { payers: bill.payers, paidBy: bill.paidBy };
  }
  if (!bill.payee) return undefined;
  return {
    payers: [bill.payee],
    paidBy: Object.fromEntries(Object.keys(bill.receipts).map((id) => [id, 0])),
  };
}
