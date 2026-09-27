import type { Bill, Share, Unit } from '../../../shared/types.ts';
import { moneyFormatter } from './money.ts';
import { currencyInfo } from '../../../shared/currency.ts';
// Type-only: this module stays pure presentation, with no path from here to
// the database client that ratelimit.ts pulls in.
import type { Rejection } from './ratelimit.ts';

/** Telegram HTML parse mode needs these three escaped, and only these three. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Collapses expanded units back into "2x Beer" lines for display. Units stay
 * expanded internally; nobody wants to read the same dish four times.
 */
export function groupUnits(units: Unit[]): { label: string; qty: number; cents: number }[] {
  const groups = new Map<string, { label: string; qty: number; cents: number }>();
  for (const unit of units) {
    const key = `${unit.displayName} ${unit.cents}`;
    const existing = groups.get(key);
    if (existing) {
      existing.qty += 1;
      existing.cents += unit.cents;
    } else {
      groups.set(key, { label: unit.displayName, qty: 1, cents: unit.cents });
    }
  }
  return [...groups.values()];
}

/**
 * Shown when the merchant name is missing or was scrubbed as unusable — an
 * illegible header, or model output that leaked non-text into the field.
 */
const MERCHANT_FALLBACK = 'Dining expenses';

/** The message that replaces "Reading receipt…" once the parse lands. */
export function parsedSummary(bill: Bill): string {
  const money = moneyFormatter(bill.currency);
  const taxLabel = currencyInfo(bill.currency).taxLabel;

  const lines: string[] = [];
  lines.push(`<b>${esc(bill.merchant || MERCHANT_FALLBACK)}</b>`);
  lines.push('');

  for (const group of groupUnits(bill.units)) {
    const qty = group.qty > 1 ? `${group.qty}× ` : '';
    lines.push(`${qty}${esc(group.label)} — ${money(group.cents)}`);
  }

  lines.push('');
  lines.push(`Subtotal: ${money(bill.subtotal)}`);
  // Receipt order: discount comes off before service and GST are added.
  if (bill.discount) lines.push(`Discount: −${money(bill.discount)}`);
  if (bill.serviceCharge) lines.push(`Service: ${money(bill.serviceCharge)}`);
  if (bill.gst) lines.push(`${taxLabel}: ${money(bill.gst)}`);
  lines.push(`<b>Total: ${money(bill.total)}</b>`);

  if (bill.note) {
    lines.push('');
    lines.push(`⚠️ ${esc(bill.note)}`);
  }

  lines.push('');
  lines.push('Check the items above — you can fix anything I misread.');
  return lines.join('\n');
}

/**
 * Label for the Mini App button.
 *
 * Deliberately leads with review rather than "Split this bill": the numbers come
 * from a model reading a photo, and a button that implies they are settled
 * invites the admin to skip the screen where they'd catch a misread. When the
 * items didn't reconcile to the printed subtotal we say so outright, because
 * that bill needs a correction, not just a glance.
 */
export function splitButtonLabel(bill: Bill): string {
  return bill.note ? 'Fix the numbers & split' : 'Review & split';
}

/**
 * One forwardable message per person, carrying the whole breakdown inline.
 *
 * This deliberately duplicates what the deep link would show. The link used to
 * be the only way to see the detail, which meant the recipient had to tap an
 * unfamiliar URL and start a bot before learning what they owed — friction for
 * everyone, and a hard stop for anyone reasonably wary of links from a
 * forwarded message. The amounts are small and static, so there is no reason to
 * put a click in front of them.
 *
 * The footer is a plain @mention rather than a deep link. A per-bill link would
 * work for a day and then break, which is worse than never offering one — and it
 * would duplicate detail the message already carries. The mention still shows
 * the figure came from a bot rather than being typed by hand, and tapping it
 * opens the bot.
 */
export function shareMessage(
  bill: Bill,
  share: Share,
  botUsername: string,
  payee?: PayeeLike,
): string {
  return [
    recipientBreakdown(bill, share, payee),
    '',
    `<i>via @${esc(botUsername)}</i>`,
  ].join('\n');
}

/**
 * Accepts either shape: the full transient payee when composing outgoing
 * messages (phone included), or the stored one when re-rendering later from the
 * database (name only, because that is all that was kept).
 */
type PayeeLike = { name: string; phone?: string; personIndex?: number };

/**
 * Telegram rejects anything over 4096 characters. Stay under it with room to
 * spare rather than discovering the limit on someone's 12-person dinner.
 */
const MAX_MESSAGE_CHARS = 3800;

/**
 * Everyone's share in one message, for pasting into a group chat.
 *
 * The per-person messages spell out each item with its price, which is right
 * when the message is for one person. Repeating that for eight people would
 * produce a wall nobody reads, so this lists item *names* only and leans on the
 * amount being the thing people actually need.
 */
export function consolidatedMessage(
  bill: Bill,
  shares: Share[],
  botUsername: string,
  payee?: PayeeLike,
): string {
  const money = moneyFormatter(bill.currency);

  /** `maxItems: Infinity` lists everything; a number truncates with "+N more". */
  const build = (maxItems: number): string => {
    const lines: string[] = [];
    lines.push(`🧾 <b>${esc(bill.merchant || MERCHANT_FALLBACK)}</b> — ${money(bill.total)}`);
    lines.push('');

    shares.forEach((share, index) => {
      // Blank line between people: this lands in a group chat where everyone is
      // scanning for their own name, and a dense block defeats that.
      if (index > 0) lines.push('');
      lines.push(`<b>${esc(share.name)}</b> — ${money(share.cents)}`);
      if (maxItems > 0) {
        const items = itemLabels(bill, share, maxItems);
        if (items.length > 0) lines.push(`<i>${esc(items.join(', '))}</i>`);
      }
    });

    const breakdown = chargeBreakdown(bill);
    const uplift = Math.round((bill.factor - 1) * 1000) / 10;
    const explanation = breakdown
      ? `Includes ${breakdown}.`
      : uplift < -0.05
        ? `Includes a ${Math.abs(uplift)}% discount applied to the whole bill.`
        : null;
    if (explanation) {
      lines.push('');
      lines.push(explanation);
    }

    if (payee?.name) {
      lines.push('');
      lines.push(
        payee.phone
          ? `Pay <b>${esc(payee.name)}</b> — <code>${esc(payee.phone)}</code>`
          : `Pay <b>${esc(payee.name)}</b> back.`,
      );
    }

    lines.push('');
    lines.push(`<i>via @${esc(botUsername)}</i>`);
    return lines.join('\n');
  };

  /*
   * Degrade only as far as the message actually forces.
   *
   * Everyone gets their complete item list first, because "+2 more" is useless
   * to the one person trying to check what they're paying for. Only if a bill is
   * genuinely enormous do item names shorten, and only after that do they go
   * entirely — amounts and who owes them can never be dropped.
   *
   * In practice the first attempt almost always wins: twelve people with six
   * items each still lands well inside the budget.
   */
  for (const maxItems of [Infinity, 3, 0]) {
    const candidate = build(maxItems);
    if (candidate.length <= MAX_MESSAGE_CHARS) return candidate;
  }
  return build(0);
}

/**
 * Item names for one person, names only — the per-person message is where the
 * itemised prices live. Truncates with "+N more" only when `max` demands it.
 */
function itemLabels(bill: Bill, share: Share, max: number): string[] {
  const units = share.unitIds
    .map((id) => bill.units.find((u) => u.id === id))
    .filter((u): u is Unit => u !== undefined);
  const grouped = groupUnits(units);
  const labels = grouped.map((g) => (g.qty > 1 ? `${g.qty} ${g.label}` : g.label));
  if (labels.length <= max) return labels;
  return [...labels.slice(0, max), `+${labels.length - max} more`];
}

/** What one person sees: their own items, their own total, and who to pay. */
export function recipientBreakdown(bill: Bill, share: Share, payee?: PayeeLike): string {
  // The person who fronted the money gets a different message. Telling them they
  // "owe" their own share and instructing them to pay themselves is nonsense —
  // they have already paid, and what they actually want to know is what the meal
  // cost them and how much is coming back.
  const isPayer = payee?.personIndex !== undefined && payee.personIndex === share.idx;
  const money = moneyFormatter(bill.currency);

  const lines: string[] = [];
  lines.push(
    isPayer
      ? `<b>${esc(share.name)}, you spent ${money(share.cents)}</b>`
      : `<b>${esc(share.name)}, you owe ${money(share.cents)}</b>`,
  );
  lines.push(`at ${esc(bill.merchant || 'this meal')}`);
  lines.push('');

  const claimCount = countClaims(bill);
  const units = share.unitIds
    .map((id) => bill.units.find((u) => u.id === id))
    .filter((u): u is Unit => u !== undefined);

  for (const group of groupUnitsWithSharing(units, claimCount, money)) {
    lines.push(group);
  }

  // Explain the gross-up rather than presenting an unexplained bigger number —
  // but only when the receipt actually itemised the charges. If it didn't, we
  // could still derive the percentage from the total, and that number would be
  // arithmetically right while attributing it to "taxes and charges" we have no
  // evidence for. Saying nothing beats naming a charge that may not exist.
  const breakdown = chargeBreakdown(bill);
  const uplift = Math.round((bill.factor - 1) * 1000) / 10;

  const explanation = breakdown
    ? `Includes ${breakdown}.`
    : uplift < -0.05
      ? `Includes a ${Math.abs(uplift)}% discount applied to the whole bill.`
      : null;

  // Pushed together so an omitted explanation doesn't leave a dangling blank.
  if (explanation) {
    lines.push('');
    lines.push(explanation);
  }

  // The actionable part, so it goes last where the eye lands. The phone only
  // exists on the first render — the forwarded message is the sole place it
  // ever appears, which is exactly why it needn't be stored.
  if (isPayer) {
    // Their own copy: what they put in, and what should come back.
    const owedBack = bill.total - share.cents;
    lines.push('');
    lines.push(
      owedBack > 0
        ? `You paid ${money(bill.total)}, so you're owed ${money(owedBack)} back.`
        : `You paid ${money(bill.total)}.`,
    );
  } else if (payee?.name) {
    lines.push('');
    lines.push(
      payee.phone
        ? `Pay <b>${esc(payee.name)}</b> — <code>${esc(payee.phone)}</code>`
        : `Pay <b>${esc(payee.name)}</b> back.`,
    );
  }

  return lines.join('\n');
}

function groupUnitsWithSharing(
  units: Unit[],
  claimCount: Map<string, number>,
  money: (cents: number) => string,
): string[] {
  const groups = new Map<string, { label: string; qty: number; cents: number; sharedBy: number }>();
  for (const unit of units) {
    const sharedBy = claimCount.get(unit.id) ?? 1;
    const key = `${unit.displayName} ${unit.cents} ${sharedBy}`;
    const existing = groups.get(key);
    if (existing) {
      existing.qty += 1;
      existing.cents += unit.cents / sharedBy;
    } else {
      groups.set(key, {
        label: unit.displayName,
        qty: 1,
        cents: unit.cents / sharedBy,
        sharedBy,
      });
    }
  }
  return [...groups.values()].map((group) => {
    const qty = group.qty > 1 ? `${group.qty}× ` : '';
    const split = group.sharedBy > 1 ? ` (split ${group.sharedBy} ways)` : '';
    return `${qty}${esc(group.label)}${split} — ${money(Math.round(group.cents))}`;
  });
}

/**
 * States the charges at the rates actually printed on the receipt — "10%
 * service charge and 9% GST" rather than the 19.9% they compound to.
 *
 * Each rate is computed against its own base, which is the whole reason the two
 * don't simply add up: service charge applies to the subtotal, and in Singapore
 * GST applies to the subtotal *plus* the service charge.
 *
 * That second base is a Singapore rule, not a universal one — whether tax lands
 * on the service charge varies by country. So on a foreign bill carrying both,
 * the tax is named without a rate: back-deriving one from an assumed base would
 * quote a percentage the receipt never printed. With no service charge the base
 * is the subtotal either way, and the rate is safe to state.
 *
 * Returns null when the receipt itemised neither charge, in which case there
 * are no rates to quote and the caller falls back to describing the effect.
 */
function chargeBreakdown(bill: Bill): string | null {
  const service = bill.serviceCharge ?? 0;
  const gst = bill.gst ?? 0;
  const { taxLabel } = currencyInfo(bill.currency);
  const parts: string[] = [];

  if (service > 0 && bill.subtotal > 0) {
    parts.push(`${formatRate(service / bill.subtotal)}% service charge`);
  }
  if (gst > 0) {
    const gstBase = bill.subtotal + service;
    if (service > 0 && bill.currency !== 'SGD') {
      parts.push(taxLabel.toLowerCase());
    } else if (gstBase > 0) {
      parts.push(`${formatRate(gst / gstBase)}% ${taxLabel}`);
    }
  }

  return parts.length > 0 ? parts.join(' and ') : null;
}

/** 0.09004 -> "9", 0.075 -> "7.5". Whole numbers lose the pointless ".0". */
function formatRate(ratio: number): string {
  const pct = Math.round(ratio * 1000) / 10;
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

function countClaims(bill: Bill): Map<string, number> {
  const counts = new Map<string, number>();
  for (const share of bill.shares) {
    for (const id of share.unitIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Shown on /start, which Telegram fires automatically the first time anyone
 * opens the bot. So it's a welcome, not a manual: what this is, why it's safe,
 * and one obvious thing to do next. The step-by-step lives in /help.
 */
/*
 * IMPORTANT: one array element per paragraph, never per visual line.
 *
 * Telegram wraps text to the reader's own window, so a newline placed to keep
 * the source tidy becomes a hard break the client then wraps *around* —
 * producing a short orphan line mid-sentence, and differently on every screen
 * width. Long paragraphs are split with `+` for source readability instead,
 * which keeps them a single logical line on the wire.
 */
export const START_TEXT = [
  '<b>AnySplit</b> splits a restaurant bill from a photo.',
  '',
  'I read the items, you tap who had what, and everyone gets their share — ' +
    'service charge and GST included, taken straight off the receipt.',
  '',
  '<i>Your receipt photo is never stored, and the bill is deleted 24 hours after ' +
    'you last touch it.</i>',
  '',
  '📸 <b>Send me a photo of your receipt to get started!</b>',
  '',
  'Or /help for the full walkthrough.',
].join('\n');

/**
 * Reply to /privacy.
 *
 * Summarised in the chat rather than only linked out: the whole claim is that
 * nothing is kept, and making someone open a browser to find that out
 * undermines it. The link carries the full text for anyone who wants it.
 */
/** "about 40 minutes", "about 3 hours" — rounded up, and never "0 minutes". */
function describeWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * What someone sees when they hit a ceiling.
 *
 * Always says when to come back: a refusal without a time reads as the bot
 * being broken, and the next thing a user does is send the photo again, which
 * is the one behaviour the limit exists to stop.
 *
 * The global message deliberately does not imply the reader did anything
 * wrong — they almost certainly didn't. Somebody else did.
 */
export function rateLimitText(refused: Rejection): string {
  const wait = describeWait(refused.retryInSeconds);

  if (refused.scope === 'global') {
    return (
      "AnySplit has hit its daily ceiling for receipts — that's a cap I put on " +
      'my own API bill, not anything you did. Try again in ' +
      `${wait} and it will have reset. Sorry about that.`
    );
  }

  const period = refused.scope === 'hour' ? 'an hour' : 'a day';
  return (
    `That's as many receipts as I can read for one person in ${period}. It keeps ` +
    'the running costs sane. Try me again in ' +
    `${wait} — nothing you've already split is affected.`
  );
}

export function privacyText(policyUrl: string): string {
  return [
    '<b>What AnySplit keeps</b>',
    '',
    '• <b>Your receipt photo — never stored.</b> It is read once and discarded.',
    '• <b>Phone numbers — never stored.</b> Used only to write your messages.',
    '• <b>The bill</b> — items, names, amounts — is deleted <b>24 hours</b> after you ' +
      'last touch it. Sending does not end it, so you can fix a split or send it a ' +
      'second way; after that it goes automatically.',
    '• <b>Logs</b> are kept 14 days. They hold timings and error messages, never your ' +
      'receipt or your messages, and your Telegram ID only as an irreversible hash.',
    '• <b>A usage count</b> is kept against that same hash — when it was first and last ' +
      'seen, and how many receipts it sent. It is how I know the bot is being used. It ' +
      'holds no bills, names or amounts, and cannot be traced back to you. Ask and it goes.',
    '',
    'No accounts, no advertising, nothing sold or shared. To read the items I send the ' +
      "photo to Anthropic's Claude API — that is the only place it goes.",
    '',
    `Full policy: ${policyUrl}`,
  ].join('\n');
}

/** The reference version, for someone who wants the steps spelled out. */
export const HELP_TEXT = [
  '<b>How AnySplit works</b>',
  '',
  '1. Send me a photo of the receipt (or send it as a file, if the print is small).',
  '2. I read it and show you the items.',
  '3. Tap <b>Review &amp; split</b> — check the prices, add names, tap items to assign them.',
  '4. I send you one message per person — or one message for the whole group.',
  '',
  'Changed your mind? Tap the same button again to adjust the split, or to send it ' +
    'the other way.',
  '',
  'Two or more people can share a single item — tap both names on it and the cost ' +
    'is divided between them.',
  '',
  'Tax and service charge are taken from the receipt itself, so hawker stalls, ' +
    'GST-only venues, and full-service restaurants all work without settings.',
  '',
  '<i>Receipt photos are never stored, and the bill is deleted 24 hours after you ' +
    'last touch it — /privacy for the detail.</i>',
].join('\n');
