import type { Receipt } from '../../../shared/types.ts';
import { formatMoney } from '../../../shared/money.ts';
import { statusOf } from '../../../shared/receipts.ts';
import { Banner, Card, PrimaryButton, Screen } from '../components/Chrome.tsx';

/**
 * Screen 0, for a bill with more than one receipt — every receipt on the bill.
 *
 * Tap one to check its items, or take it off the bill. New receipts can't be
 * added here: photos go to the chat, never through this page, so it never
 * handles an image at all. The hint says where the button is.
 */
export function Receipts({
  receipts,
  blocker,
  onOpen,
  onRemove,
  onRefresh,
  onNext,
  busy,
}: {
  receipts: Receipt[];
  /** Why splitting can't start yet (splitBlocker), or null. */
  blocker: string | null;
  onOpen: (receipt: Receipt) => void;
  onRemove: (receipt: Receipt) => void;
  onRefresh: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  const reading = receipts.some((receipt) => statusOf(receipt) === 'parsing');
  // Only a meaningful sum when everything is read and in one currency.
  const total = blocker ? null : receipts.reduce((sum, receipt) => sum + receipt.total, 0);

  return (
    <Screen
      title="Receipts"
      subtitle="Tap one to check its items. Everything here is split as one bill."
      footer={
        <>
          {total !== null ? (
            <div className="mb-3 flex items-center justify-between text-sm font-medium">
              <span>Total paid</span>
              <span className="tabular-nums">{formatMoney(total, receipts[0]!.currency)}</span>
            </div>
          ) : null}
          <PrimaryButton label="Add people" onClick={onNext} disabled={blocker !== null} busy={busy} />
        </>
      }
    >
      {blocker ? <Banner tone="warn">{blocker}</Banner> : null}

      <Card>
        {receipts.map((receipt, index) => {
          const status = statusOf(receipt);
          return (
            <div
              key={receipt.receiptId}
              className={`flex items-center gap-2 px-3 py-3 ${
                index > 0 ? 'border-t border-tg-separator' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => onOpen(receipt)}
                disabled={status !== 'review'}
                className="flex min-w-0 flex-1 items-baseline justify-between gap-2 text-left active:opacity-60 disabled:active:opacity-100"
              >
                <span className="min-w-0">
                  <span className="block truncate text-base">
                    {status === 'parsing' ? 'Reading…' : receipt.merchant || `Receipt ${index + 1}`}
                  </span>
                  <span className="block text-xs text-tg-hint">
                    {status === 'parsing'
                      ? 'Still reading the photo'
                      : status === 'error'
                        ? "Couldn't be read"
                        : receipt.note
                          ? '⚠️ Check the numbers'
                          : `${receipt.units.length} item${receipt.units.length === 1 ? '' : 's'}`}
                  </span>
                </span>
                {status === 'review' ? (
                  <span className="shrink-0 text-base tabular-nums">
                    {formatMoney(receipt.total, receipt.currency)}
                  </span>
                ) : null}
              </button>
              {receipts.length > 1 ? (
                <button
                  type="button"
                  onClick={() => onRemove(receipt)}
                  aria-label={`Remove ${receipt.merchant || `receipt ${index + 1}`}`}
                  className="px-1 text-lg text-tg-hint active:opacity-60"
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </Card>

      {reading ? (
        <button
          type="button"
          onClick={onRefresh}
          className="mt-2 text-sm font-medium text-tg-link active:opacity-60"
        >
          Check again
        </button>
      ) : null}

      <p className="mt-4 text-xs text-tg-hint">
        To add another, tap <b>➕ Add another receipt</b> in the chat and send the photo there.
      </p>
    </Screen>
  );
}
