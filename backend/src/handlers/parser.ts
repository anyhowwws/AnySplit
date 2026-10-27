import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { Bill } from '../../../shared/types.ts';
import { billKeyboard, parseFailureText, registerHandlers } from '../lib/bot.ts';
import { receiptsOf } from '../../../shared/receipts.ts';
import { deriveReceipt } from '../lib/receipt.ts';
import { getBill, markReceiptFailed, removeReceipt, saveReceipt } from '../lib/db.ts';
import { parsedSummary } from '../lib/format.ts';
import { addLogContext, errorFields, log, withLogContext } from '../lib/log.ts';
import { cropToReceipt } from '../lib/preprocess.ts';
import { isParseJob, type ParseJob } from '../lib/queue.ts';
import { downloadImage, getBot } from '../lib/telegram.ts';
import { VisionError, parseReceipt } from '../lib/vision.ts';

/** Raised for anything the user can fix by retaking the photo. Not retried. */
class UnrecoverableError extends Error {}

/**
 * SQS-triggered. Does the vision call, writes the units, then edits the
 * original "Reading receipt…" message in place.
 *
 * Reports partial batch failures so a single transient failure doesn't force
 * redelivery of the whole batch (and a duplicate parse for its siblings).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await withLogContext({ sqsMessageId: record.messageId }, () => processRecord(record));
    } catch (err) {
      if (err instanceof UnrecoverableError) {
        // Already reported to the user. Retrying would just burn vision calls.
        log.warn('unrecoverable parse, not retrying', {
          messageId: record.messageId,
          ...errorFields(err),
        });
        // Deliberately not a batchItemFailure: retrying burns vision spend on an
        // image that will fail identically.
        continue;
      }
      log.error('parse failed, will retry', { messageId: record.messageId, ...errorFields(err) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

async function processRecord(record: SQSRecord): Promise<void> {
  let job: unknown;
  try {
    job = JSON.parse(record.body);
  } catch {
    throw new UnrecoverableError('unparseable job body');
  }
  if (!isParseJob(job)) throw new UnrecoverableError('job body missing required fields');

  addLogContext({
    billId: job.billId,
    receiptId: job.receiptId,
    attempt: record.attributes.ApproximateReceiveCount,
  });

  const bill = await getBill(job.billId);
  if (!bill) {
    // Expired or deleted between enqueue and delivery. Nothing to do.
    log.info('parse job for missing bill, dropping');
    return;
  }
  const receipt = bill.receipts[job.receiptId];
  if (!receipt) {
    // Removed from the bill while its photo waited in the queue.
    log.info('parse job for removed receipt, dropping');
    return;
  }
  // A first receipt queued before receipts carried a status of their own has
  // none; for it, the bill's status still says whether it's been read.
  const parsing =
    receipt.status === 'parsing' || (receipt.status === undefined && bill.status === 'parsing');
  if (!parsing) {
    // A duplicate delivery for a receipt we already parsed.
    log.info('parse job for already-parsed receipt, dropping', { status: receipt.status });
    return;
  }

  const bot = await getBot(registerHandlers);

  try {
    await parseAndSave(bot, bill, job);
  } catch (err) {
    if (err instanceof VisionError) {
      await reportFailure(bot, bill, job, err.message);
      throw new UnrecoverableError(err.message);
    }
    throw err;
  }
}

async function parseAndSave(
  bot: Awaited<ReturnType<typeof getBot>>,
  bill: Bill,
  job: ParseJob,
): Promise<void> {
  const started = Date.now();
  const raw = await downloadImage(bot, { fileId: job.fileId, mediaType: job.mediaType });

  // Crop away the table before the model sees it — the single biggest accuracy
  // lever measured, bigger than the model upgrade, and it lowers token cost
  // too. Falls back to the original image on any failure.
  const crop = await cropToReceipt(raw);
  log.info('image preprocessed', {
    cropped: crop.cropped,
    keptFraction: Number(crop.keptFraction.toFixed(3)),
    ms: Date.now() - started,
  });

  const receipt = await parseReceipt(crop.image);

  const placeholder = bill.receipts[job.receiptId]!;
  const derived = {
    ...deriveReceipt(receipt, job.receiptId, placeholder.seq),
    status: 'review' as const,
  };
  if (derived.units.length === 0) throw new VisionError("couldn't find any line items");

  // The bill as a whole is ready once its first receipt is; a later receipt
  // landing leaves it wherever it already was.
  const billStatus = bill.status === 'parsing' ? 'review' : undefined;
  const saved = await saveReceipt(bill, derived, billStatus);

  log.info('receipt parsed', {
    items: receipt.items.length,
    units: derived.units.length,
    subtotal: derived.subtotal,
    total: derived.total,
    factor: derived.factor,
    reconciled: derived.note === undefined,
    saved,
    ms: Date.now() - started,
  });

  if (!saved) {
    await bot.api.editMessageText(
      job.chatId,
      job.messageId,
      'That receipt was removed from the bill before I finished reading it.',
    );
    return;
  }

  const updated: Bill = {
    ...bill,
    receipts: { ...bill.receipts, [derived.receiptId]: derived },
    status: billStatus ?? bill.status,
  };
  const position = receiptsOf(updated).findIndex((r) => r.receiptId === derived.receiptId) + 1;

  await bot.api.editMessageText(job.chatId, job.messageId, parsedSummary(derived, position), {
    parse_mode: 'HTML',
    reply_markup: billKeyboard(updated),
  });
}

/**
 * A bill's first receipt failing fails the bill — there's nothing else on it.
 * A later one is taken off again instead, so an unreadable photo never stands
 * between the admin and splitting the receipts that did read; the reply says
 * so and offers the button to try another photo.
 */
async function reportFailure(
  bot: Awaited<ReturnType<typeof getBot>>,
  bill: Bill,
  job: ParseJob,
  reason: string,
): Promise<void> {
  const first = bill.status === 'parsing';
  const logFailure = (what: string) => (err: unknown) =>
    log.error(what, { billId: job.billId, ...errorFields(err) });

  if (first) {
    await markReceiptFailed(job.billId, job.receiptId, reason, true).catch(
      logFailure('failed to mark bill errored'),
    );
    await bot.api
      .editMessageText(job.chatId, job.messageId, parseFailureText(reason), { parse_mode: 'HTML' })
      .catch(logFailure('failed to edit placeholder'));
    return;
  }

  await removeReceipt(job.billId, job.receiptId).catch(logFailure('failed to remove receipt'));
  const { [job.receiptId]: _failed, ...remaining } = bill.receipts;
  await bot.api
    .editMessageText(
      job.chatId,
      job.messageId,
      `${parseFailureText(reason)}\n\nIt's been left off the bill; the other receipts are as they were.`,
      { parse_mode: 'HTML', reply_markup: billKeyboard({ ...bill, receipts: remaining }) },
    )
    .catch(logFailure('failed to edit placeholder'));
}
