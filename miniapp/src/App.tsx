import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bill, SendMode, Share, Unit } from '../../shared/types.ts';
import { CalcError, computeShares, deriveFactor, subtotalOf } from '../../shared/calc.ts';
import { DEFAULT_CURRENCY } from '../../shared/currency.ts';
import { type Payee } from '../../shared/payee.ts';
import { ApiRequestError, fetchBill, finaliseBill, patchBill } from './lib/api.ts';
import {
  alertUser,
  billIdFromUrl,
  closeApp,
  haptic,
  insideTelegram,
  onBack,
  ownFirstName,
} from './lib/telegram.ts';
import { Banner, Centered } from './components/Chrome.tsx';
import { Assign, type Assignment } from './screens/Assign.tsx';
import { People } from './screens/People.tsx';
import { Review } from './screens/Review.tsx';
import { Summary } from './screens/Summary.tsx';

type Step = 'review' | 'people' | 'assign' | 'summary';

const STEP_ORDER: Step[] = ['review', 'people', 'assign', 'summary'];

export function App() {
  const billId = useMemo(billIdFromUrl, []);

  const [bill, setBill] = useState<Bill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('review');
  const [busy, setBusy] = useState(false);
  // Which delivery the admin chose, so the confirmation can name it.
  const [sent, setSent] = useState<SendMode | null>(null);

  // Working copies. The server holds the truth; these are the admin's edits
  // until the PATCH on leaving Review.
  const [merchant, setMerchant] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [units, setUnits] = useState<Unit[]>([]);
  const [totalCents, setTotalCents] = useState(0);
  const [names, setNames] = useState<string[]>([]);
  const [assignment, setAssignment] = useState<Assignment>({});
  // Prefilled with the admin's own Telegram name — they paid it themselves
  // most of the time, and it is trivially editable when they didn't.
  const [payee, setPayee] = useState<Payee>(() => ({ name: ownFirstName(), phone: '' }));

  const load = useCallback(async () => {
    // No bill id at all isn't a load failure — it means the app was opened
    // directly rather than from the bot's button. Handled by its own gate below,
    // because "Try again" would be useless advice.
    if (!billId) return;
    try {
      const { bill: loaded } = await fetchBill(billId);
      setBill(loaded);
      setMerchant(loaded.merchant);
      setCurrency(loaded.currency);
      setUnits(loaded.units);
      setTotalCents(loaded.total);
      setLoadError(null);

      // Re-opening a bill that was already sent: rebuild the working state from
      // the stored shares so the admin lands on the summary with everything as
      // they left it — ready to send the other format, or to step back and fix
      // the split. Without this they'd face an empty People screen and have to
      // redo the whole assignment.
      if (loaded.status === 'final' && loaded.shares.length > 0) {
        setNames(loaded.shares.map((share) => share.name));

        const restored: Assignment = {};
        loaded.shares.forEach((share, personIndex) => {
          for (const unitId of share.unitIds) {
            (restored[unitId] ??= []).push(personIndex);
          }
        });
        setAssignment(restored);

        // Name only — the phone was never stored, so it has to be retyped if
        // they want it in the resent messages.
        if (loaded.payee?.name) {
          setPayee((current) => ({
            ...current,
            name: loaded.payee!.name,
            personIndex: loaded.payee!.personIndex,
          }));
        }
        setStep('summary');
      }
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Could not load this bill.');
    }
  }, [billId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Native back button walks the step list rather than the browser history —
  // there is no history here, it's one page.
  useEffect(() => {
    const index = STEP_ORDER.indexOf(step);
    if (index <= 0 || sent !== null) return onBack(null);
    return onBack(() => setStep(STEP_ORDER[index - 1]!));
  }, [step, sent]);

  const subtotal = subtotalOf(units);
  const factor = deriveFactor(subtotal, totalCents);

  /** Person assignments in the shape the calc and the API both want. */
  const people = useMemo(
    () =>
      names.map((name, index) => ({
        name,
        unitIds: units.filter((unit) => (assignment[unit.id] ?? []).includes(index)).map((u) => u.id),
      })),
    [names, units, assignment],
  );

  const preview = useMemo<{ shares: Share[] } | { error: string }>(() => {
    if (step !== 'summary') return { shares: [] };
    try {
      return { shares: computeShares(units, factor, totalCents, people) };
    } catch (err) {
      return { error: err instanceof CalcError ? err.message : 'Could not work out the split.' };
    }
  }, [step, units, factor, totalCents, people]);

  async function saveAndContinue() {
    if (!bill) return;
    setBusy(true);
    try {
      const { bill: updated } = await patchBill(bill.billId, {
        merchant,
        currency,
        total: totalCents,
        units,
      });
      setBill(updated);
      setUnits(updated.units);
      // Any unit the admin deleted must not linger in the assignment map.
      const live = new Set(updated.units.map((u) => u.id));
      setAssignment((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))),
      );
      setStep('people');
    } catch (err) {
      alertUser(err instanceof ApiRequestError ? err.message : 'Could not save those changes.');
    } finally {
      setBusy(false);
    }
  }

  async function send(mode: SendMode) {
    if (!bill) return;
    setBusy(true);
    try {
      // Resolve the payer's index if it wasn't chosen explicitly — the prefilled
      // Telegram name often matches someone in the list.
      const resolved =
        payee.personIndex ??
        people.findIndex((p) => p.name.trim().toLowerCase() === payee.name.trim().toLowerCase());
      await finaliseBill(bill.billId, {
        people,
        payee: { ...payee, personIndex: resolved >= 0 ? resolved : undefined },
        mode,
      });
      haptic('success');
      setSent(mode);
      // Give the success screen a beat to render before the sheet closes.
      setTimeout(closeApp, 1200);
    } catch (err) {
      haptic('error');
      alertUser(err instanceof ApiRequestError ? err.message : 'Could not send the split.');
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------- gates */

  if (!insideTelegram) {
    return (
      <Centered>
        <p className="text-base font-medium">Open AnySplit from Telegram</p>
        <p className="text-sm text-tg-hint">
          This page needs a Telegram session to know which bill it's showing.
        </p>
      </Centered>
    );
  }

  // Reachable by opening the CloudFront URL directly, or via a bookmark — the
  // app is useless without knowing which bill to show. Point somewhere useful
  // rather than reporting an error the reader can't act on.
  if (!billId) {
    return (
      <Centered>
        <p className="text-base font-medium">Nothing to split yet</p>
        <p className="text-sm text-tg-hint">
          Send a photo of your receipt to the bot, then tap <b>Review &amp; split</b> on its
          reply — the bill opens here automatically.
        </p>
      </Centered>
    );
  }

  if (loadError) {
    return (
      <Centered>
        <p className="text-base font-medium">{loadError}</p>
        <button type="button" onClick={() => void load()} className="text-sm font-medium text-tg-link">
          Try again
        </button>
      </Centered>
    );
  }

  if (!bill) {
    return (
      <Centered>
        <p className="text-sm text-tg-hint">Loading…</p>
      </Centered>
    );
  }

  if (sent) {
    return (
      <Centered>
        <p className="text-2xl">✅</p>
        <p className="text-base font-medium">Sent to your chat</p>
        <p className="text-sm text-tg-hint">
          {sent === 'group'
            ? 'Forward that message straight into your group chat.'
            : 'Forward each message to the person it names.'}
        </p>
      </Centered>
    );
  }

  if (bill.status === 'parsing') {
    return (
      <Centered>
        <p className="text-base font-medium">Still reading the receipt</p>
        <p className="text-sm text-tg-hint">This usually takes a few seconds.</p>
        <button type="button" onClick={() => void load()} className="text-sm font-medium text-tg-link">
          Check again
        </button>
      </Centered>
    );
  }

  if (bill.status === 'error') {
    return (
      <Centered>
        <p className="text-base font-medium">I couldn't read that receipt</p>
        {bill.note ? <p className="text-sm text-tg-hint">{bill.note}</p> : null}
        <p className="text-sm text-tg-hint">Send a clearer photo to the bot and try again.</p>
      </Centered>
    );
  }

  /* ------------------------------------------------------------ screens */

  switch (step) {
    case 'review':
      return (
        <Review
          merchant={merchant}
          setMerchant={setMerchant}
          currency={currency}
          setCurrency={setCurrency}
          units={units}
          setUnits={setUnits}
          totalCents={totalCents}
          setTotalCents={setTotalCents}
          note={bill.note}
          onNext={() => void saveAndContinue()}
          busy={busy}
        />
      );

    case 'people':
      return (
        <People names={names} setNames={setNames} onNext={() => setStep('assign')} />
      );

    case 'assign':
      return (
        <Assign
          units={units}
          currency={currency}
          names={names}
          assignment={assignment}
          setAssignment={setAssignment}
          onNext={() => setStep('summary')}
        />
      );

    case 'summary':
      if ('error' in preview) {
        return (
          <Centered>
            <Banner tone="error">{preview.error}</Banner>
            <button
              type="button"
              onClick={() => setStep('assign')}
              className="text-sm font-medium text-tg-link"
            >
              Back to items
            </button>
          </Centered>
        );
      }
      return (
        <Summary
          shares={preview.shares}
          units={units}
          total={totalCents}
          currency={currency}
          factor={factor}
          names={names}
          payee={payee}
          setPayee={setPayee}
          alreadySent={bill.status === 'final'}
          onSend={(mode) => void send(mode)}
          busy={busy}
        />
      );
  }
}
