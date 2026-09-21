import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { Bill } from '../../../shared/types.ts';
import { parseFailureText, registerHandlers } from '../lib/bot.ts';
import { deriveBill } from '../lib/receipt.ts';
import { getBill, saveParse, setStatus } from '../lib/db.ts';
import { parsedSummary, splitButtonLabel } from '../lib/format.ts';
import { addLogContext, errorFields, log, withLogContext } from '../lib/log.ts';
import { cropToReceipt } from '../lib/preprocess.ts';
import { isParseJob, type ParseJob } from '../lib/queue.ts';
import { downloadImage, getBot, miniAppUrl } from '../lib/telegram.ts';
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

  addLogContext({ billId: job.billId, attempt: record.attributes.ApproximateReceiveCount });

  const bill = await getBill(job.billId);
  if (!bill) {
    // Expired or deleted between enqueue and delivery. Nothing to do.
    log.info('parse job for missing bill, dropping');
    return;
  }
  if (bill.status !== 'parsing') {
    // A duplicate delivery for a bill we already parsed.
    log.info('parse job for already-parsed bill, dropping', { status: bill.status });
    return;
  }

  const bot = await getBot(registerHandlers);

  try {
    await parseAndSave(bot, bill, job);
  } catch (err) {
    if (err instanceof VisionError) {
      await reportFailure(bot, job, err.message);
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

  const derived = deriveBill(receipt);
  if (derived.units.length === 0) throw new VisionError("couldn't find any line items");

  await saveParse(bill.billId, {
    merchant: derived.merchant,
    currency: derived.currency,
    subtotal: derived.subtotal,
    total: derived.total,
    factor: derived.factor,
    units: derived.units,
    serviceCharge: derived.serviceCharge,
    gst: derived.gst,
    discount: derived.discount,
    status: 'review',
    note: derived.note,
  });

  log.info('receipt parsed', {
    items: receipt.items.length,
    units: derived.units.length,
    subtotal: derived.subtotal,
    total: derived.total,
    factor: derived.factor,
    reconciled: derived.note === undefined,
    ms: Date.now() - started,
  });

  const updated: Bill = { ...bill, ...derived, status: 'review' };

  await bot.api.editMessageText(job.chatId, job.messageId, parsedSummary(updated), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: splitButtonLabel(updated), web_app: { url: miniAppUrl(bill.billId) } }],
      ],
    },
  });
}

async function reportFailure(
  bot: Awaited<ReturnType<typeof getBot>>,
  job: ParseJob,
  reason: string,
): Promise<void> {
  await setStatus(job.billId, 'error', reason).catch((err) =>
    log.error('failed to mark bill errored', { billId: job.billId, ...errorFields(err) }),
  );
  await bot.api
    .editMessageText(job.chatId, job.messageId, parseFailureText(reason), { parse_mode: 'HTML' })
    .catch((err) =>
      log.error('failed to edit placeholder', { billId: job.billId, ...errorFields(err) }),
    );
}
