import { useState } from 'react';
import type { SendMode, Share, Unit } from '../../../shared/types.ts';
import { type Payee, normalisePhone } from '../../../shared/payee.ts';
import { formatCents } from '../../../shared/money.ts';
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
 * These shares are computed locally with the same `computeShares` the backend
 * runs on finalise, so what the admin approves here is exactly what gets sent.
 */
export function Summary({
  shares,
  units,
  total,
  factor,
  names,
  payee,
  setPayee,
  alreadySent,
  onSend,
  busy,
}: {
  shares: Share[];
  units: Unit[];
  total: number;
  factor: number;
  /** The people splitting, so the payer can be picked rather than retyped. */
  names: string[];
  payee: Payee;
  setPayee: (payee: Payee) => void;
  /** True when re-opened after sending — the split can be changed and re-sent. */
  alreadySent: boolean;
  onSend: (mode: SendMode) => void;
  busy: boolean;
}) {
  // Only complain about a phone once they've finished typing it.
  const [phoneTouched, setPhoneTouched] = useState(false);
  const phoneLooksWrong =
    phoneTouched && payee.phone.trim() !== '' && normalisePhone(payee.phone) === null;
  // A re-opened bill brings back the payee's name but never their number.
  const needsPhoneAgain = alreadySent && payee.name.trim() !== '' && payee.phone.trim() === '';

  // An explicit selection wins; otherwise fall back to matching the prefilled
  // Telegram name against the list, so the right chip lights up on first view.
  const matchedIndex =
    payee.personIndex ??
    names.findIndex((n) => n.trim().toLowerCase() === payee.name.trim().toLowerCase());
  const someoneElse = matchedIndex < 0;

  const sum = shares.reduce((acc, share) => acc + share.cents, 0);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const upliftPct = (factor - 1) * 100;

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
            busy={busy}
          />
          <SecondaryButton
            label={alreadySent ? 'Send one message for the group' : 'One message for the group'}
            hint="Everyone's share in a single message"
            onClick={() => onSend('group')}
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
                    {formatCents(share.cents)}
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
          <span className="tabular-nums">{formatCents(sum)}</span>
        </div>
        <div className="flex items-center justify-between font-medium">
          <span>Bill total</span>
          <span className="tabular-nums">{formatCents(total)}</span>
        </div>
      </div>

      {/*
        Who's owed the money, sitting immediately above the send buttons.
        Deliberately here rather than back on the People screen: it is an input
        the send consumes, and on a re-opened bill the phone always needs
        retyping — putting it two screens away meant navigating back to find it.
      */}
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
        <div className="mb-2 flex flex-wrap gap-1.5">
          {names.map((name, index) => {
            const active = index === matchedIndex;
            return (
              <button
                key={index}
                type="button"
                onClick={() => setPayee({ ...payee, name, personIndex: index })}
                aria-pressed={active}
                className="rounded-full px-3 py-1.5 text-sm font-medium transition-opacity active:opacity-70"
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
            onClick={() => setPayee({ ...payee, name: '', personIndex: undefined })}
            aria-pressed={someoneElse}
            className="rounded-full px-3 py-1.5 text-sm font-medium transition-opacity active:opacity-70"
            style={
              someoneElse
                ? { backgroundColor: 'var(--color-tg-button)', color: 'var(--color-tg-button-text)' }
                : { backgroundColor: 'var(--color-tg-secondary)', color: 'var(--color-tg-link)' }
            }
          >
            Someone else
          </button>
        </div>

        <div className="overflow-hidden rounded-xl bg-tg-secondary">
          {/* Only needed when the payer isn't one of the people above. */}
          {someoneElse ? (
            <input
              value={payee.name}
              onChange={(event) =>
                setPayee({ ...payee, name: event.target.value, personIndex: undefined })
              }
              placeholder="Name of whoever paid"
              className="w-full border-b border-tg-separator bg-transparent px-3 py-2.5 text-base outline-none"
            />
          ) : null}
          <input
            value={payee.phone}
            onChange={(event) => setPayee({ ...payee, phone: event.target.value })}
            onBlur={() => {
              setPhoneTouched(true);
              // Tidy on the way out, so what's shown here is what recipients get.
              const tidied = normalisePhone(payee.phone);
              if (tidied) setPayee({ ...payee, phone: tidied });
            }}
            placeholder="Phone for PayNow (optional)"
            inputMode="tel"
            autoComplete="tel"
            className="w-full bg-transparent px-3 py-2.5 text-base outline-none"
          />
        </div>
        <p
          className={`mt-2 text-xs ${
            phoneLooksWrong ? 'text-tg-destructive' : needsPhoneAgain ? 'text-tg-link' : 'text-tg-hint'
          }`}
        >
          {phoneLooksWrong
            ? "That doesn't look like a phone number — it'll be left out."
            : needsPhoneAgain
              ? "Phone numbers are never stored, so this one didn't come back — retype it to include it again."
              : 'Shown to everyone so they know who to pay back. Leave blank to skip.'}
        </p>
      </div>

      <p className="mt-3 text-xs text-tg-hint">
        {Math.abs(upliftPct) >= 0.05
          ? `Each share includes its own portion of the ${upliftPct > 0 ? `${upliftPct.toFixed(1)}% service charge and GST` : `${Math.abs(upliftPct).toFixed(1)}% discount`}. `
          : ''}
        Rounding to whole cents leaves a cent or two over; it goes to the largest
        share so the shares add up to exactly {formatCents(total)}.
      </p>
    </Screen>
  );
}

function summarise(items: string[]): string {
  if (items.length === 0) return 'nothing assigned';
  const unique = [...new Set(items)];
  if (unique.length <= 3) return unique.join(', ');
  return `${unique.slice(0, 3).join(', ')} +${unique.length - 3} more`;
}
