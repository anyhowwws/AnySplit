import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bill, Receipt, SendMode, Share, Unit } from '../../shared/types.ts';
import { CalcError, computeBillShares } from '../../shared/calc.ts';
import { DEFAULT_CURRENCY } from '../../shared/currency.ts';
import { type Payee } from '../../shared/payee.ts';
import { allUnits, receiptsOf, readyReceipts, splitBlocker } from '../../shared/receipts.ts';
import { ApiRequestError, fetchBill, finaliseBill, patchBill, removeReceipt } from './lib/api.ts';
import {
  alertUser,
  billIdFromUrl,
  closeApp,
  confirmUser,
  haptic,
  insideTelegram,
  onBack,
  ownFirstName,
} from './lib/telegram.ts';
import { Banner, Centered } from './components/Chrome.tsx';
import { Assign, type Assignment } from './screens/Assign.tsx';
import { People } from './screens/People.tsx';
import { Receipts } from './screens/Receipts.tsx';
import { Review } from './screens/Review.tsx';
import { Summary } from './screens/Summary.tsx';

/**
 * `receipts` only appears for a bill with more than one; with one, Review is
 * the first screen, exactly as before bills could hold several.
 */
type Step = 'receipts' | 'review' | 'people' | 'assign' | 'summary';

export function App() {
  const billId = useMemo(billIdFromUrl, []);

  const [bill, setBill] = useState<Bill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('review');
  const [busy, setBusy] = useState(false);
  // Which delivery the admin chose, so the confirmation can name it.
  const [sent, setSent] = useState<SendMode | null>(null);

  // Working copy of the receipt open in Review. The server holds the truth;
  // these are the admin's edits until the PATCH on leaving Review.
  const [editing, setEditing] = useState<Receipt | null>(null);
  const [merchant, setMerchant] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [units, setUnits] = useState<Unit[]>([]);
  const [totalCents, setTotalCents] = useState(0);

  const [names, setNames] = useState<string[]>([]);
  const [assignment, setAssignment] = useState<Assignment>({});
  // Prefilled with the admin's own Telegram name — they paid it themselves
  // most of the time, and it is trivially editable when they didn't.
  const [payee, setPayee] = useState<Payee>(() => ({ name: ownFirstName(), phone: '' }));

  const receipts = useMemo(() => (bill ? receiptsOf(bill) : []), [bill]);
  const multi = receipts.length > 1;

  function openReview(receipt: Receipt) {
    setEditing(receipt);
    setMerchant(receipt.merchant);
    setCurrency(receipt.currency);
    setUnits(receipt.units);
    setTotalCents(receipt.total);
    setStep('review');
  }

  /**
   * Takes a fresh copy of the bill from the server, dropping any assignment to
   * a unit that's no longer on it — deleted in Review, or on a receipt that
   * was removed.
   */
  function adopt(updated: Bill) {
    setBill(updated);
    const live = new Set(allUnits(updated).map((u) => u.id));
    setAssignment((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))),
    );
  }

  const load = useCallback(async () => {
    // No bill id at all isn't a load failure — it means the app was opened
    // directly rather than from the bot's button. Handled by its own gate below,
    // because "Try again" would be useless advice.
    if (!billId) return;
    try {
      const { bill: loaded } = await fetchBill(billId);
      setBill(loaded);
      setLoadError(null);

      const loadedReceipts = receiptsOf(loaded);
      if (loadedReceipts.length > 1) setStep('receipts');
      else openReview(loadedReceipts[0]!);

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

        // Straight to the summary — unless a receipt was added after sending,
        // whose items nobody has been given yet. Then it's the start, so the
        // new receipt gets looked at before anything is re-sent.
        const everyUnitAssigned = allUnits(loaded).every((unit) => restored[unit.id]?.length);
        if (everyUnitAssigned && !splitBlocker(loadedReceipts)) setStep('summary');
      }
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Could not load this bill.');
    }
  }, [billId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The receipts list's "Check again", while a photo is still being read. */
  async function refresh() {
    if (!billId) return;
    try {
      adopt((await fetchBill(billId)).bill);
    } catch (err) {
      alertUser(err instanceof ApiRequestError ? err.message : 'Could not load this bill.');
    }
  }

  // Native back button walks the steps rather than the browser history —
  // there is no history here, it's one page.
  useEffect(() => {
    const previous: Partial<Record<Step, Step>> = multi
      ? { review: 'receipts', people: 'receipts', assign: 'people', summary: 'assign' }
      : { people: 'review', assign: 'people', summary: 'assign' };
    const back = previous[step];
    if (!back || sent !== null) return onBack(null);
    return onBack(() => setStep(back));
  }, [step, sent, multi]);

  // Only receipts that have been read carry items. splitBlocker keeps the
  // others from reaching People at all; this keeps them out of the sums.
  const splitting = useMemo(() => (bill ? readyReceipts(bill) : []), [bill]);
  const splitUnits = useMemo(() => splitting.flatMap((r) => r.units), [splitting]);

  /** Person assignments in the shape the calc and the API both want. */
  const people = useMemo(
    () =>
      names.map((name, index) => ({
        name,
        unitIds: splitUnits
          .filter((unit) => (assignment[unit.id] ?? []).includes(index))
          .map((u) => u.id),
      })),
    [names, splitUnits, assignment],
  );

  const preview = useMemo<{ shares: Share[] } | { error: string }>(() => {
    if (step !== 'summary') return { shares: [] };
    try {
      return { shares: computeBillShares(splitting, people) };
    } catch (err) {
      return { error: err instanceof CalcError ? err.message : 'Could not work out the split.' };
    }
  }, [step, splitting, people]);

  /**
   * An id for a unit added in Review that no unit anywhere on the bill has:
   * the assignment and the shares know units by id alone.
   */
  function newUnitId(current: Unit[]): string {
    const prefix = editing?.receiptId ?? '';
    const taken = new Set([
      ...current.map((u) => u.id),
      ...(bill ? allUnits(bill).map((u) => u.id) : []),
    ]);
    // Counter rather than units.length, so ids stay unique after deletes.
    let n = current.length;
    while (taken.has(`${prefix}u${n}`)) n++;
    return `${prefix}u${n}`;
  }

  async function saveAndContinue() {
    if (!bill || !editing) return;
    setBusy(true);
    try {
      const { bill: updated } = await patchBill(bill.billId, {
        receiptId: editing.receiptId,
        merchant,
        currency,
        total: totalCents,
        units,
      });
      adopt(updated);
      setUnits(updated.receipts[editing.receiptId]?.units ?? units);
      setStep(receiptsOf(updated).length > 1 ? 'receipts' : 'people');
    } catch (err) {
      alertUser(err instanceof ApiRequestError ? err.message : 'Could not save those changes.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(receipt: Receipt) {
    if (!bill) return;
    const label = receipt.merchant || 'this receipt';
    if (!(await confirmUser(`Take ${label} off this bill?`))) return;
    setBusy(true);
    try {
      adopt((await removeReceipt(bill.billId, receipt.receiptId)).bill);
      haptic('success');
    } catch (err) {
      alertUser(err instanceof ApiRequestError ? err.message : 'Could not remove that receipt.');
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
    case 'receipts':
      return (
        <Receipts
          receipts={receipts}
          blocker={splitBlocker(receipts)}
          onOpen={openReview}
          onRemove={(receipt) => void remove(receipt)}
          onRefresh={() => void refresh()}
          onNext={() => setStep('people')}
          busy={busy}
        />
      );

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
          note={editing?.note}
          newUnitId={newUnitId}
          nextLabel={multi ? 'Save this receipt' : 'Add people'}
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
          sections={splitting.map((receipt, index) => ({
            key: receipt.receiptId,
            title: multi ? receipt.merchant || `Receipt ${index + 1}` : undefined,
            units: receipt.units,
          }))}
          currency={splitting[0]?.currency ?? DEFAULT_CURRENCY}
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
          receipts={splitting}
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
