/**
 * Thin typed wrapper over `window.Telegram.WebApp`.
 *
 * Deliberately raw rather than @telegram-apps/sdk-react — we use a handful of
 * methods, and the SDK is more surface area than the feature needs.
 */

interface TelegramWebApp {
  initData: string;
  /**
   * The same fields as initData but NOT signed. Safe for prefilling a field the
   * user can see and edit; never send it anywhere as identity. The backend
   * derives who you are from the verified `initData` HMAC alone.
   */
  initDataUnsafe?: {
    user?: { id?: number; first_name?: string; last_name?: string; username?: string };
  };
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  close(): void;
  showAlert(message: string, callback?: () => void): void;
  showConfirm(message: string, callback: (confirmed: boolean) => void): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const webApp: TelegramWebApp | undefined = window.Telegram?.WebApp;

/** True when running inside a real Telegram client with a signed initData. */
export const insideTelegram = Boolean(webApp?.initData);

export function initTelegram(): void {
  webApp?.ready();
  webApp?.expand();
}

export function haptic(kind: 'select' | 'success' | 'error'): void {
  const feedback = webApp?.HapticFeedback;
  if (!feedback) return;
  if (kind === 'select') feedback.selectionChanged();
  else feedback.notificationOccurred(kind);
}

export function closeApp(): void {
  webApp?.close();
}

/** Falls back to `alert` outside Telegram so dev builds still surface errors. */
export function alertUser(message: string): void {
  if (webApp) webApp.showAlert(message);
  else window.alert(message);
}

/** Registers the native back button for the lifetime of the returned cleanup. */
export function onBack(handler: (() => void) | null): () => void {
  const button = webApp?.BackButton;
  if (!button) return () => {};
  if (!handler) {
    button.hide();
    return () => {};
  }
  button.onClick(handler);
  button.show();
  return () => {
    button.offClick(handler);
    button.hide();
  };
}

/**
 * The admin's own first name, for prefilling "who's collecting?" — they paid it
 * themselves most of the time. Display only; see initDataUnsafe above.
 */
export function ownFirstName(): string {
  return webApp?.initDataUnsafe?.user?.first_name?.trim() ?? '';
}

/** The bill id is passed on the Mini App URL when the bot opens it. */
export function billIdFromUrl(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('bill');
  if (fromQuery) return fromQuery;
  // Telegram sometimes preserves only the hash on cold starts.
  const hash = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(hash).get('bill');
}
