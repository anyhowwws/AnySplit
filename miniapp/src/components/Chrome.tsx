import type { ReactNode } from 'react';

/** Full-height screen with a sticky action footer. */
export function Screen({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-tg-bg text-tg-text">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-tg-hint">{subtitle}</p> : null}
      </header>

      <main className="flex-1 px-4 pb-4">{children}</main>

      {footer ? (
        <footer className="sticky bottom-0 border-t border-tg-separator bg-tg-bg px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}

export function PrimaryButton({
  label,
  hint,
  onClick,
  disabled,
  busy,
}: {
  label: string;
  /** Optional second line, for when the label alone can't carry the choice. */
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="w-full rounded-xl bg-tg-button px-4 py-3 text-base font-semibold text-tg-button-text transition-opacity active:opacity-80 disabled:opacity-40"
    >
      {busy ? 'Working…' : label}
      {hint && !busy ? (
        <span className="mt-0.5 block text-xs font-normal opacity-75">{hint}</span>
      ) : null}
    </button>
  );
}

/**
 * Same footprint as PrimaryButton but visually quieter — for a genuine
 * alternative rather than a lesser action. Both choices here are equally valid;
 * one just has to look like the default.
 */
export function SecondaryButton({
  label,
  hint,
  onClick,
  disabled,
  busy,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="w-full rounded-xl bg-tg-secondary px-4 py-3 text-base font-semibold text-tg-link transition-opacity active:opacity-80 disabled:opacity-40"
    >
      {busy ? 'Working…' : label}
      {hint && !busy ? (
        <span className="mt-0.5 block text-xs font-normal text-tg-hint">{hint}</span>
      ) : null}
    </button>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl bg-tg-secondary">
      {children}
    </div>
  );
}

export function Banner({ tone, children }: { tone: 'warn' | 'error'; children: ReactNode }) {
  const colour =
    tone === 'error'
      ? 'text-tg-destructive border-tg-destructive/40'
      : 'text-tg-text border-tg-separator';
  return (
    <div className={`mb-3 rounded-xl border px-3 py-2.5 text-sm ${colour}`} role="status">
      {children}
    </div>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-tg-bg px-8 text-center text-tg-text">
      {children}
    </div>
  );
}

/** Distinct colour per person, so chips are recognisable at a glance. */
export const PERSON_COLOURS = [
  '#3390ec',
  '#e17076',
  '#7bc862',
  '#eda86c',
  '#a695e7',
  '#65aadd',
  '#ee7aae',
  '#6ec9cb',
  '#f2a33c',
  '#8f7be0',
  '#5eb98a',
  '#d97ec2',
] as const;

export function personColour(index: number): string {
  return PERSON_COLOURS[index % PERSON_COLOURS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
