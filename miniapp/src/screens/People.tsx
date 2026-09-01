import { useState } from 'react';
import { MAX_PEOPLE, MIN_PEOPLE } from '../lib/limits.ts';
import { Card, PrimaryButton, Screen, initials, personColour } from '../components/Chrome.tsx';

/**
 * Screen 2 — who's splitting.
 *
 * Free-text names, no roster and no accounts: the name is written straight into
 * the forwarded message, so "Marcus" only has to mean something to the person
 * doing the forwarding.
 */
export function People({
  names,
  setNames,
  onNext,
}: {
  names: string[];
  setNames: (names: string[]) => void;
  onNext: () => void;
}) {
  const [draft, setDraft] = useState('');

  function addName() {
    const name = draft.trim();
    if (!name || names.length >= MAX_PEOPLE) return;
    setNames([...names, name]);
    setDraft('');
  }

  function removeName(index: number) {
    setNames(names.filter((_, i) => i !== index));
  }

  const full = names.length >= MAX_PEOPLE;

  return (
    <Screen
      title="Who's in?"
      subtitle={`${MIN_PEOPLE}–${MAX_PEOPLE} people. Include yourself.`}
      footer={
        <PrimaryButton
          label="Assign items"
          onClick={onNext}
          disabled={names.length < MIN_PEOPLE}
        />
      }
    >
      <Card>
        {names.map((name, index) => (
          <div
            key={`${name}-${index}`}
            className={`flex items-center gap-3 px-3 py-2.5 ${
              index > 0 ? 'border-t border-tg-separator' : ''
            }`}
          >
            <span
              className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
              style={{ backgroundColor: personColour(index) }}
            >
              {initials(name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-base">{name}</span>
            <button
              type="button"
              onClick={() => removeName(index)}
              aria-label={`Remove ${name}`}
              className="px-1 text-lg text-tg-hint active:opacity-60"
            >
              ×
            </button>
          </div>
        ))}
        {names.length === 0 ? (
          <p className="px-3 py-4 text-sm text-tg-hint">No one yet.</p>
        ) : null}
      </Card>

      {full ? (
        <p className="mt-3 text-sm text-tg-hint">
          That's the maximum. For bigger groups, split the bill in two halves.
        </p>
      ) : (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addName();
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Name"
            autoComplete="off"
            enterKeyHint="done"
            className="min-w-0 flex-1 rounded-xl bg-tg-secondary px-3 py-2.5 text-base outline-none"
          />
          <button
            type="submit"
            disabled={draft.trim() === ''}
            className="rounded-xl bg-tg-secondary px-4 py-2.5 text-base font-medium text-tg-link disabled:opacity-40"
          >
            Add
          </button>
        </form>
      )}
    </Screen>
  );
}
