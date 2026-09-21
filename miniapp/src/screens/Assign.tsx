import type { Unit } from '../../../shared/types.ts';
import { formatMoney } from '../../../shared/money.ts';
import { currencyInfo } from '../../../shared/currency.ts';
import { unassignedCents } from '../../../shared/calc.ts';
import { PrimaryButton, Screen, initials, personColour } from '../components/Chrome.tsx';
import { haptic } from '../lib/telegram.ts';

/** unitId -> indexes into `names`. Several people on one unit means a split. */
export type Assignment = Record<string, number[]>;

/**
 * Screen 3 — tap items onto people.
 *
 * Units are listed individually rather than grouped, which is the whole point of
 * expanding quantities: giving one of two beers to Marcus and the other to Priya
 * is two taps, with no fraction UI anywhere.
 */
export function Assign({
  units,
  currency,
  names,
  assignment,
  setAssignment,
  onNext,
}: {
  units: Unit[];
  currency: string;
  names: string[];
  assignment: Assignment;
  setAssignment: (next: Assignment) => void;
  onNext: () => void;
}) {
  const taxLabel = currencyInfo(currency).taxLabel;
  const labels = disambiguate(units);
  const outstanding = unassignedCents(
    units,
    names.map((name, index) => ({
      name,
      unitIds: units.filter((u) => (assignment[u.id] ?? []).includes(index)).map((u) => u.id),
    })),
  );

  // Gate on the unit *count*, not just the cents: a $0.00 item (a comped dish, or
  // a blank row the admin added) leaves nothing outstanding but still fails
  // computeShares, which requires every unit claimed before it reconciles.
  const unclaimed = units.filter((unit) => (assignment[unit.id] ?? []).length === 0).length;
  const ready = unclaimed === 0;

  function toggle(unitId: string, person: number) {
    const current = assignment[unitId] ?? [];
    const next = current.includes(person)
      ? current.filter((p) => p !== person)
      : [...current, person].sort((a, b) => a - b);
    haptic('select');
    setAssignment({ ...assignment, [unitId]: next });
  }

  function toggleEveryone(unitId: string) {
    const current = assignment[unitId] ?? [];
    const everyone = current.length === names.length;
    haptic('select');
    setAssignment({ ...assignment, [unitId]: everyone ? [] : names.map((_, i) => i) });
  }

  /** Pre-selects everything the model flagged as a likely shared dish. */
  function shareAllFlagged() {
    const next: Assignment = { ...assignment };
    for (const unit of units) {
      if (unit.shared) next[unit.id] = names.map((_, i) => i);
    }
    haptic('select');
    setAssignment(next);
  }

  const hasFlagged = units.some((unit) => unit.shared);
  const flaggedUnassigned = units.some(
    (unit) => unit.shared && (assignment[unit.id] ?? []).length === 0,
  );

  return (
    <Screen
      title="Who had what?"
      subtitle="Tap a person to add them to an item. Two or more splits it."
      footer={
        <>
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className={ready ? 'text-tg-hint' : 'text-tg-destructive'}>
              {ready
                ? 'Everything assigned'
                : outstanding > 0
                  ? `Unassigned: ${formatMoney(outstanding, currency)}`
                  : `${unclaimed} item${unclaimed === 1 ? '' : 's'} still unassigned`}
            </span>
          </div>
          <PrimaryButton label="See the split" onClick={onNext} disabled={!ready} />
        </>
      }
    >
      {hasFlagged && flaggedUnassigned ? (
        <button
          type="button"
          onClick={shareAllFlagged}
          className="mb-3 w-full rounded-xl bg-tg-secondary px-3 py-2.5 text-sm font-medium text-tg-link active:opacity-70"
        >
          Split the shared dishes across everyone
        </button>
      ) : null}

      <div className="space-y-2">
        {units.map((unit) => {
          const selected = assignment[unit.id] ?? [];
          const everyone = selected.length === names.length && names.length > 0;
          const perHead = selected.length > 0 ? unit.cents / selected.length : 0;

          return (
            <div key={unit.id} className="rounded-xl bg-tg-secondary px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-base">
                  {labels.get(unit.id)}
                  {unit.shared ? <span className="ml-1 text-xs text-tg-hint">shared?</span> : null}
                </span>
                <span className="shrink-0 text-base tabular-nums">{formatMoney(unit.cents, currency)}</span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {names.map((name, index) => {
                  const on = selected.includes(index);
                  return (
                    <button
                      key={index}
                      type="button"
                      onClick={() => toggle(unit.id, index)}
                      aria-pressed={on}
                      className="flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-sm font-medium transition-opacity active:opacity-70"
                      style={
                        on
                          ? { backgroundColor: personColour(index), color: '#fff' }
                          : { backgroundColor: 'var(--color-tg-bg)', color: 'var(--color-tg-hint)' }
                      }
                    >
                      <span
                        className="grid size-5 place-items-center rounded-full text-[10px] font-semibold text-white"
                        style={{ backgroundColor: on ? 'rgba(0,0,0,0.2)' : personColour(index) }}
                      >
                        {initials(name)}
                      </span>
                      {name}
                    </button>
                  );
                })}

                {names.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => toggleEveryone(unit.id)}
                    aria-pressed={everyone}
                    className="rounded-full px-2.5 py-1 text-sm font-medium active:opacity-70"
                    style={
                      everyone
                        ? { backgroundColor: 'var(--color-tg-button)', color: 'var(--color-tg-button-text)' }
                        : { backgroundColor: 'var(--color-tg-bg)', color: 'var(--color-tg-link)' }
                    }
                  >
                    Everyone
                  </button>
                ) : null}
              </div>

              {selected.length > 1 ? (
                <p className="mt-1.5 text-xs text-tg-hint">
                  {formatMoney(Math.round(perHead), currency)} each, before service and {taxLabel}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </Screen>
  );
}

/**
 * "Beer" appearing twice becomes "Beer (1 of 2)" and "Beer (2 of 2)", so a row
 * is identifiable when you're checking your work against the paper receipt.
 */
function disambiguate(units: Unit[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const unit of units) {
    const key = unit.displayName || 'Item';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const unit of units) {
    const key = unit.displayName || 'Item';
    const total = counts.get(key)!;
    if (total === 1) {
      labels.set(unit.id, key);
    } else {
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      labels.set(unit.id, `${key} (${nth} of ${total})`);
    }
  }
  return labels;
}
