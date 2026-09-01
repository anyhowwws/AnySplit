import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config.ts';
import type { ImageMediaType } from './vision.ts';

const sqs = new SQSClient({});

/**
 * Everything the parser needs. The image itself is not carried here — only the
 * Telegram file_id, which the parser exchanges for a short-lived download URL.
 */
export interface ParseJob {
  billId: string;
  fileId: string;
  mediaType: ImageMediaType;
  /** Where to edit the "Reading receipt…" placeholder once we're done. */
  chatId: number;
  messageId: number;
}

export async function enqueueParse(job: ParseJob): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.parseQueueUrl(),
      MessageBody: JSON.stringify(job),
    }),
  );
}

export function isParseJob(value: unknown): value is ParseJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<ParseJob>;
  return (
    typeof job.billId === 'string' &&
    typeof job.fileId === 'string' &&
    typeof job.mediaType === 'string' &&
    typeof job.chatId === 'number' &&
    typeof job.messageId === 'number'
  );
}
