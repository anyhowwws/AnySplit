import type { Unit } from '../../../shared/types.ts';
import { centsToPlain, formatMoney, parseCents } from '../../../shared/money.ts';
import { SUPPORTED_CURRENCY_CODES, currencyInfo } from '../../../shared/currency.ts';
import { deriveFactor, subtotalOf } from '../../../shared/calc.ts';
import { Banner, Card, PrimaryButton, Screen } from '../components/Chrome.tsx';

/**
 * Screen 1 — confirm the parse.
 *
 * A model proposes, the admin confirms. Nothing leaves the app without a human
 * having seen it, so every field the vision call produced is editable here.
 */
export function Review({
  merchant,
  setMerchant,
  currency,
  setCurrency,
  units,
  setUnits,
  totalCents,
  setTotalCents,
  note,
  onNext,
  busy,
}: {
  merchant: string;
  setMerchant: (value: string) => void;
  currency: string;
  setCurrency: (value: string) => void;
  units: Unit[];
  setUnits: (units: Unit[]) => void;
  totalCents: number;
  setTotalCents: (cents: number) => void;
  note?: string;
  onNext: () => void;
  busy: boolean;
}) {
  const subtotal = subtotalOf(units);
  const factor = deriveFactor(subtotal, totalCents);
  const upliftPct = (factor - 1) * 100;
  const { symbol, minorDigits, taxLabel } = currencyInfo(currency);

  function updateUnit(id: string, patch: Partial<Unit>) {
    setUnits(units.map((unit) => (unit.id === id ? { ...unit, ...patch } : unit)));
  }

  function removeUnit(id: string) {
    setUnits(units.filter((unit) => unit.id !== id));
  }

  function addUnit() {
    // Suffix from a counter, not units.length, so ids stay unique after deletes.
    const taken = new Set(units.map((u) => u.id));
    let n = units.length;
    while (taken.has(`u${n}`)) n++;
    setUnits([...units, { id: `u${n}`, name: '', displayName: '', cents: 0, shared: false }]);
  }

  const canContinue = units.length > 0 && totalCents > 0 && subtotal > 0;

  return (
    <Screen
      title="Check the items"
      subtitle="Fix anything I misread. Tap a price to edit it."
      footer={
        <PrimaryButton
          label="Add people"
          onClick={onNext}
          disabled={!canContinue}
          busy={busy}
        />
      }
    >
      {note ? <Banner tone="warn">⚠️ {note}</Banner> : null}

      <div className="mb-4 flex gap-2">
        <label className="min-w-0 flex-1 block">
          <span className="mb-1 block text-xs font-medium tracking-wide text-tg-hint uppercase">
            Where
          </span>
          <input
            value={merchant}
            onChange={(event) => setMerchant(event.target.value)}
            placeholder="Restaurant name"
            className="w-full rounded-xl bg-tg-secondary px-3 py-2.5 text-base outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-wide text-tg-hint uppercase">
            Currency
          </span>
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            className="h-full rounded-xl bg-tg-secondary px-3 py-2.5 text-base outline-none"
          >
            {SUPPORTED_CURRENCY_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </div>

      <span className="mb-1 block text-xs font-medium tracking-wide text-tg-hint uppercase">
        Items
      </span>
      <Card>
        {units.map((unit, index) => (
          <div
            key={unit.id}
            className={`flex items-center gap-2 px-3 py-2 ${
              index > 0 ? 'border-t border-tg-separator' : ''
            }`}
          >
            <input
              value={unit.displayName}
              onChange={(event) =>
                updateUnit(unit.id, {
                  displayName: event.target.value,
                  // Keep `name` (the raw receipt text) if it was ever set.
                  name: unit.name || event.target.value,
                })
              }
              placeholder="Item"
              className="min-w-0 flex-1 bg-transparent text-base outline-none"
            />
            <span className="text-tg-hint">{symbol}</span>
            <input
              // Keyed on currency: an uncontrolled input's defaultValue only
              // takes effect on mount, so switching currency (which can change
              // minorDigits — 2-decimal to 0-decimal) needs a remount to
              // reformat the figure already sitting in the box.
              key={currency}
              defaultValue={centsToPlain(unit.cents, minorDigits)}
              onBlur={(event) => {
                const cents = parseCents(event.target.value, minorDigits);
                if (cents === null || cents < 0) {
                  // Reject silently and snap back — an inline error for a typo
                  // in a 20-row list is more noise than help.
                  event.target.value = centsToPlain(unit.cents, minorDigits);
                  return;
                }
                event.target.value = centsToPlain(cents, minorDigits);
                updateUnit(unit.id, { cents });
              }}
              inputMode="decimal"
              className="w-20 rounded-lg bg-tg-bg px-2 py-1 text-right text-base outline-none"
            />
            <button
              type="button"
              onClick={() => removeUnit(unit.id)}
              aria-label={`Remove ${unit.displayName || 'item'}`}
              className="px-1 text-lg text-tg-hint active:opacity-60"
            >
              ×
            </button>
          </div>
        ))}
      </Card>

      <button
        type="button"
        onClick={addUnit}
        className="mt-2 text-sm font-medium text-tg-link active:opacity-60"
      >
        + Add an item
      </button>

      <div className="mt-6 space-y-1.5 text-sm">
        <Row label="Items" value={formatMoney(subtotal, currency)} />
        <div className="flex items-center justify-between">
          <span className="text-tg-hint">Total paid</span>
          <div className="flex items-center gap-1">
            <span className="text-tg-hint">{symbol}</span>
            <input
              // See the item-price input above for why this remounts on currency.
              key={currency}
              defaultValue={centsToPlain(totalCents, minorDigits)}
              onBlur={(event) => {
                const cents = parseCents(event.target.value, minorDigits);
                if (cents === null || cents <= 0) {
                  event.target.value = centsToPlain(totalCents, minorDigits);
                  return;
                }
                event.target.value = centsToPlain(cents, minorDigits);
                setTotalCents(cents);
              }}
              inputMode="decimal"
              className="w-24 rounded-lg bg-tg-secondary px-2 py-1 text-right text-base font-semibold outline-none"
            />
          </div>
        </div>
        {subtotal > 0 ? (
          <p className="pt-1 text-xs text-tg-hint">
            {Math.abs(upliftPct) < 0.05
              ? `No service charge or ${taxLabel} on this bill.`
              : upliftPct > 0
                ? `Service charge and ${taxLabel} add ${upliftPct.toFixed(1)}%, spread across everyone in proportion to what they ordered.`
                : `A ${Math.abs(upliftPct).toFixed(1)}% discount, spread across everyone in proportion to what they ordered.`}
          </p>
        ) : null}
      </div>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-tg-hint">{label}</span>
      <span>{value}</span>
    </div>
  );
}
