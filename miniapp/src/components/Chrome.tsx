import { type FocusEvent, type ReactNode, useState } from 'react';

/** A field that brings up the on-screen keyboard. */
function isTextField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(target.type);
}

/**
 * Full-height screen with a sticky action footer.
 *
 * The footer steps aside while a text field has focus. Sticky to the bottom
 * of the viewport, it rides up on top of the on-screen keyboard and covers
 * whatever field sits just above it — on a phone, exactly the one being typed
 * into. Its buttons are for after the typing anyway, and come back as soon as
 * the field loses focus.
 */
export function Screen({
  title,
  subtitle,
  children,
  footer,
  footerWhileTyping = false,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Keep the footer up while typing — for a screen whose only field sits at
   * the top, out of the footer's way, and whose footer is the next step.
   */
  footerWhileTyping?: boolean;
}) {
  const [typing, setTyping] = useState(false);

  function onFocus(event: FocusEvent) {
    if (!isTextField(event.target)) return;
    setTyping(true);
    // Once the keyboard has finished opening and the viewport has shrunk.
    const field = event.target;
    setTimeout(() => field.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  }

  function onBlur(event: FocusEvent) {
    // Moving straight to another field keeps the footer away, rather than
    // flashing it back for a frame between the two.
    if (isTextField(event.target) && !isTextField(event.relatedTarget)) setTyping(false);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-tg-bg text-tg-text" onFocus={onFocus} onBlur={onBlur}>
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-tg-hint">{subtitle}</p> : null}
      </header>

      <main className="flex-1 px-4 pb-4">{children}</main>

      {footer && (footerWhileTyping || !typing) ? (
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
