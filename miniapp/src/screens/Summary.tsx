import { useState } from 'react';
import type { Receipt, SendMode, Share } from '../../../shared/types.ts';
import { normalisePhone } from '../../../shared/payee.ts';
import { settle } from '../../../shared/settle.ts';
import {
  type PayerRef,
  type PaymentDraft,
  buildPayment,
  payerName,
  payerRef,
  phoneKey,
} from '../lib/payment.ts';
import { formatMoney } from '../../../shared/money.ts';
import { currencyInfo } from '../../../shared/currency.ts';
import {
  Card,
  PrimaryButton,
  Screen,
  SecondaryButton,
  initials,
  personColour,
} from '../components/Chrome.tsx';

/**
 * Screen 4 — the numbers, then send.
 *
 * These shares are computed locally with the same `computeBillShares` the backend
 * runs on finalise, so what the admin approves here is exactly what gets sent.
 */
export function Summary({
  shares,
  receipts,
  names,
  draft,
  setDraft,
  ownName,
  alreadySent,
  onSend,
  busy,
}: {
  shares: Share[];
  /** Every receipt being split. All in one currency — the split refuses otherwise. */
  receipts: Receipt[];
  /** The people splitting, so the payer can be picked rather than retyped. */
  names: string[];
  /** Who paid each receipt, and their phones. */
  draft: PaymentDraft;
  setDraft: (draft: PaymentDraft) => void;
  /** The admin's Telegram first name: the default payer. */
  ownName: string;
  /** True when re-opened after sending — the split can be changed and re-sent. */
  alreadySent: boolean;
  onSend: (mode: SendMode) => void;
  busy: boolean;
}) {
  // Only complain about a phone once they've finished typing it.
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const refOf = (receipt: Receipt): PayerRef =>
    payerRef(draft, names, receipt.receiptId, ownName);
  const refs = receipts.map(refOf);
  /** Everyone who paid something, in the order they first paid. */
  const payerRefs = [...new Set(refs)];
  const usesOther = refs.includes('other');

  function pick(receipt: Receipt, ref: PayerRef) {
    // Choosing "someone else" afresh starts with an empty name to type — but
    // not when another receipt already names them, which would wipe it.
    const clearName = ref === 'other' && !usesOther;
    setDraft({
      ...draft,
      paidBy: { ...draft.paidBy, [receipt.receiptId]: ref },
      otherName: clearName ? '' : draft.otherName,
    });
  }

  const phoneOf = (ref: PayerRef) => draft.phones[phoneKey(ref)] ?? '';
  function setPhone(ref: PayerRef, phone: string) {
    setDraft({ ...draft, phones: { ...draft.phones, [phoneKey(ref)]: phone } });
  }
  function tidyPhone(ref: PayerRef) {
    setTouched({ ...touched, [phoneKey(ref)]: true });
    // Tidy on the way out, so what's shown here is what recipients get.
    const tidied = normalisePhone(phoneOf(ref));
    if (tidied) setPhone(ref, tidied);
  }
  const phoneLooksWrong = (ref: PayerRef) =>
    Boolean(touched[phoneKey(ref)]) && phoneOf(ref).trim() !== '' && normalisePhone(phoneOf(ref)) === null;
  // A re-opened bill brings back the payers' names but never their numbers.
  const needsPhoneAgain = (ref: PayerRef) =>
    alreadySent && payerName(draft, names, ref) !== '' && phoneOf(ref).trim() === '';

  // Several payers: each is somebody to pay, so each needs a name.
  const missingName = payerRefs.length > 1 && usesOther && draft.otherName.trim() === '';
  const payment = buildPayment(draft, names, receipts, ownName);
  const settlement =
    !missingName && payment && payment.payers.length > 1 ? settle(shares, receipts, payment) : null;

  const currency = receipts[0]!.currency;
  const total = receipts.reduce((acc, receipt) => acc + receipt.total, 0);
  const sum = shares.reduce((acc, share) => acc + share.cents, 0);
  const unitById = new Map(receipts.flatMap((r) => r.units).map((unit) => [unit.id, unit]));
  const multi = receipts.length > 1;
  // One receipt: its gross-up as a single figure. Several: each has its own,
  // so there's no one percentage that would be true.
  const upliftPct = multi ? 0 : (receipts[0]!.factor - 1) * 100;
  const taxLabel = currencyInfo(currency).taxLabel;
  // PayNow is Singapore-specific — naming it on a foreign-currency bill would
  // claim a payment rail that has nothing to do with what was actually paid.
  // The field itself needs no other change: phone-linked mobile payment is
  // the norm across most of the region this bot covers (DuitNow, PromptPay,
  // GCash, …), and normalisePhone already passes through anything outside
  // Singapore's own number shape rather than rejecting it.
  const rail = currency === 'SGD' ? 'PayNow' : 'payment';
  const phonePlaceholder = `Phone for ${rail} (optional)`;
  /** Under a payer's name, when there are several: "Ann — phone for PayNow (optional)". */
  const phoneFor = `phone for ${rail} (optional)`;

  return (
    <Screen
      title="The split"
      subtitle={
        alreadySent
          ? 'Already sent. Change anything and send again, or send the other format.'
          : "Pick how you'd like it delivered."
      }
      footer={
        <div className="space-y-2">
          <PrimaryButton
            label={alreadySent ? 'Send the breakdown per person again' : 'Send me the breakdown per person'}
            hint="One message each, ready to forward"
            onClick={() => onSend('personal')}
            disabled={missingName}
            busy={busy}
          />
          <SecondaryButton
            label={alreadySent ? 'Send one message for the group' : 'One message for the group'}
            hint="Everyone's share in a single message"
            onClick={() => onSend('group')}
            disabled={missingName}
            busy={busy}
          />
        </div>
      }
    >
      <Card>
        {shares.map((share, index) => {
          const items = share.unitIds
            .map((id) => unitById.get(id)?.displayName)
            .filter((name): name is string => Boolean(name));

          return (
            <div
              key={share.idx}
              className={`flex items-start gap-3 px-3 py-3 ${
                index > 0 ? 'border-t border-tg-separator' : ''
              }`}
            >
              <span
                className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                style={{ backgroundColor: personColour(share.idx) }}
              >
                {initials(share.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-base font-medium">{share.name}</span>
                  <span className="shrink-0 text-base font-semibold tabular-nums">
                    {formatMoney(share.cents, currency)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-tg-hint">
                  {summarise(items)}
                </p>
              </div>
            </div>
          );
        })}
      </Card>

      <div className="mt-4 space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-tg-hint">Sum of shares</span>
          <span className="tabular-nums">{formatMoney(sum, currency)}</span>
        </div>
        <div className="flex items-center justify-between font-medium">
          <span>Bill total</span>
          <span className="tabular-nums">{formatMoney(total, currency)}</span>
        </div>
      </div>

      {/*
        Who's owed the money, sitting immediately above the send buttons.
        Deliberately here rather than back on the People screen: it is an input
        the send consumes, and on a re-opened bill the phone always needs
        retyping — putting it two screens away meant navigating back to find it.
      */}
      {multi ? (
        <div className="mt-6">
          <span className="mb-1 block text-xs font-medium tracking-wide text-tg-hint uppercase">
            Who paid?
          </span>
          {receipts.map((receipt, index) => (
            <div key={receipt.receiptId} className="mb-3">
              <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate">{receipt.merchant || `Receipt ${index + 1}`}</span>
                <span className="shrink-0 text-tg-hint tabular-nums">
                  {formatMoney(receipt.total, currency)}
                </span>
              </div>
              <PayerChips names={names} selected={refOf(receipt)} onPick={(ref) => pick(receipt, ref)} />
            </div>
          ))}

          <div className="overflow-hidden rounded-xl bg-tg-secondary">
            {usesOther ? (
              <input
                value={draft.otherName}
                onChange={(event) => setDraft({ ...draft, otherName: event.target.value })}
                placeholder="Name of whoever else paid"
                className="w-full border-b border-tg-separator bg-transparent px-3 py-2.5 text-base outline-none"
              />
            ) : null}
            {payerRefs.map((ref, index) => (
              <input
                key={phoneKey(ref)}
                value={phoneOf(ref)}
                onChange={(event) => setPhone(ref, event.target.value)}
                onBlur={() => tidyPhone(ref)}
                placeholder={`${payerName(draft, names, ref) || 'Their'} — ${phoneFor}`}
                inputMode="tel"
                autoComplete="tel"
                className={`w-full bg-transparent px-3 py-2.5 text-base outline-none ${
                  index > 0 ? 'border-t border-tg-separator' : ''
                }`}
              />
            ))}
          </div>
          <p
            className={`mt-2 text-xs ${
              missingName || payerRefs.some(phoneLooksWrong)
                ? 'text-tg-destructive'
                : payerRefs.some(needsPhoneAgain)
                  ? 'text-tg-link'
                  : 'text-tg-hint'
            }`}
          >
            {missingName
              ? 'Add the name of whoever else paid — everyone needs to know who to pay.'
              : payerRefs.some(phoneLooksWrong)
                ? "One of those doesn't look like a phone number — it'll be left out."
                : payerRefs.some(needsPhoneAgain)
                  ? "Phone numbers are never stored, so they didn't come back — retype them to include them again."
                  : 'Shown to everyone so they know who to pay. Leave blank to skip.'}
          </p>

          {settlement ? (
            <div className="mt-4">
              <span className="mb-1 block text-xs font-medium tracking-wide text-tg-hint uppercase">
                To settle up
              </span>
              <Card>
                {settlement.transfers.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-tg-hint">Everyone's square.</p>
                ) : (
                  settlement.transfers.map((transfer, index) => (
                    <div
                      key={index}
                      className={`flex items-baseline justify-between gap-2 px-3 py-2.5 text-sm ${
                        index > 0 ? 'border-t border-tg-separator' : ''
                      }`}
                    >
                      <span className="min-w-0 truncate">
                        {settlement.parties[transfer.from]!.name} →{' '}
                        <b>{settlement.parties[transfer.to]!.name}</b>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatMoney(transfer.cents, currency)}
                      </span>
                    </div>
                  ))
                )}
              </Card>
              <p className="mt-2 text-xs text-tg-hint">
                Netted across the receipts, so nobody pays back and forth.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-6">
          <span className="mb-1 block text-xs font-medium tracking-wide text-tg-hint uppercase">
            Who's collecting?
          </span>
          {/*
            Pick from the people already entered, because usually one of them paid.
            Selecting a person is what lets their own message read "you spent"
            instead of instructing them to pay themselves — matched by index, since
            two people can share a name.
          */}
          <div className="mb-2">
            <PayerChips
              names={names}
              selected={refs[0]!}
              onPick={(ref) => pick(receipts[0]!, ref)}
              roomy
            />
          </div>

          <div className="overflow-hidden rounded-xl bg-tg-secondary">
            {/* Only needed when the payer isn't one of the people above. */}
            {refs[0] === 'other' ? (
              <input
                value={draft.otherName}
                onChange={(event) => setDraft({ ...draft, otherName: event.target.value })}
                placeholder="Name of whoever paid"
                className="w-full border-b border-tg-separator bg-transparent px-3 py-2.5 text-base outline-none"
              />
            ) : null}
            <input
              value={phoneOf(refs[0]!)}
              onChange={(event) => setPhone(refs[0]!, event.target.value)}
              onBlur={() => tidyPhone(refs[0]!)}
              placeholder={phonePlaceholder}
              inputMode="tel"
              autoComplete="tel"
              className="w-full bg-transparent px-3 py-2.5 text-base outline-none"
            />
          </div>
          <p
            className={`mt-2 text-xs ${
              phoneLooksWrong(refs[0]!)
                ? 'text-tg-destructive'
                : needsPhoneAgain(refs[0]!)
                  ? 'text-tg-link'
                  : 'text-tg-hint'
            }`}
          >
            {phoneLooksWrong(refs[0]!)
              ? "That doesn't look like a phone number — it'll be left out."
              : needsPhoneAgain(refs[0]!)
                ? "Phone numbers are never stored, so this one didn't come back — retype it to include it again."
                : 'Shown to everyone so they know who to pay back. Leave blank to skip.'}
          </p>
        </div>
      )}

      <p className="mt-3 text-xs text-tg-hint">
        {multi
          ? `Each receipt's service charge and ${taxLabel} go on the items from that receipt only. `
          : ''}
        {Math.abs(upliftPct) >= 0.05
          ? `Each share includes its own portion of the ${upliftPct > 0 ? `${upliftPct.toFixed(1)}% service charge and ${taxLabel}` : `${Math.abs(upliftPct).toFixed(1)}% discount`}. `
          : ''}
        {multi
          ? 'Rounding leaves a little over on each receipt; it goes to the largest share there, so the shares add up to exactly '
          : 'Rounding leaves a little over; it goes to the largest share so the shares add up to exactly '}
        {formatMoney(total, currency)}.
      </p>
    </Screen>
  );
}

/**
 * One chip per person, plus "Someone else", for picking who paid. Matched by
 * index rather than name, since two people can share a name.
 */
function PayerChips({
  names,
  selected,
  onPick,
  roomy = false,
}: {
  names: string[];
  selected: PayerRef;
  onPick: (ref: PayerRef) => void;
  /** The single-payer layout's larger chips. */
  roomy?: boolean;
}) {
  const size = roomy ? 'px-3 py-1.5' : 'px-2.5 py-1';
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((name, index) => {
        const active = index === selected;
        return (
          <button
            key={index}
            type="button"
            onClick={() => onPick(index)}
            aria-pressed={active}
            className={`rounded-full ${size} text-sm font-medium transition-opacity active:opacity-70`}
            style={
              active
                ? { backgroundColor: personColour(index), color: '#fff' }
                : { backgroundColor: 'var(--color-tg-secondary)', color: 'var(--color-tg-hint)' }
            }
          >
            {name}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => onPick('other')}
        aria-pressed={selected === 'other'}
        className={`rounded-full ${size} text-sm font-medium transition-opacity active:opacity-70`}
        style={
          selected === 'other'
            ? { backgroundColor: 'var(--color-tg-button)', color: 'var(--color-tg-button-text)' }
            : { backgroundColor: 'var(--color-tg-secondary)', color: 'var(--color-tg-link)' }
        }
      >
        Someone else
      </button>
    </div>
  );
}

function summarise(items: string[]): string {
  if (items.length === 0) return 'nothing assigned';
  const unique = [...new Set(items)];
  if (unique.length <= 3) return unique.join(', ');
  return `${unique.slice(0, 3).join(', ')} +${unique.length - 3} more`;
}
