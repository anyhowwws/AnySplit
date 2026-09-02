import Anthropic from '@anthropic-ai/sdk';
import type { ParsedReceipt } from '../../../shared/types.ts';
import { config } from './config.ts';
import { isCents } from './money.ts';
import { log } from './log.ts';
import { visionClient } from './anthropic.ts';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ReceiptImage {
  /** Base64, no data: prefix, no newlines. */
  data: string;
  mediaType: ImageMediaType;
}

export class VisionError extends Error {}

/**
 * Forced tool use gives us schema-valid JSON instead of prose we'd have to
 * unfence. `strict: true` means `input` is guaranteed to match this schema, so
 * the runtime checks below are about *plausibility*, not shape.
 *
 * The intersection is a hedge: `strict` is a newer top-level field on the tool
 * definition, and older SDK typings omit it even though the API accepts it.
 * Widening here beats pinning an exact SDK patch version.
 */
const RECEIPT_TOOL: Anthropic.Tool & { strict?: boolean } = {
  name: 'record_receipt',
  description:
    'Record the structured contents of a restaurant or hawker receipt. Call this exactly once.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'merchant',
      'items',
      'subtotalCents',
      'serviceChargeCents',
      'gstCents',
      'discountCents',
      'totalCents',
    ],
    properties: {
      merchant: {
        type: 'string',
        description: 'Restaurant or stall name as printed. Empty string if not legible.',
      },
      items: {
        type: 'array',
        description: 'Every ordered line item, in the order printed.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rawName', 'displayName', 'qty', 'unitPriceCents', 'isLikelyShared'],
          properties: {
            rawName: {
              type: 'string',
              description:
                'The item name exactly as printed, including abbreviations and any Chinese or ' +
                'other non-Latin characters. Do not translate or expand here.',
            },
            displayName: {
              type: 'string',
              description:
                'A readable expansion of rawName. "TRFL FRS" -> "Truffle Fries", ' +
                '"CHKN RICE" -> "Chicken Rice". For non-Latin names, give an English rendering ' +
                'if you are confident, otherwise repeat rawName.',
            },
            qty: {
              type: 'integer',
              description: 'Quantity ordered. Use 1 when the receipt shows no quantity column.',
            },
            unitPriceCents: {
              type: 'integer',
              description:
                'Price of ONE unit, as an INTEGER NUMBER OF CENTS. $12.00 is 1200, not 12 and ' +
                'not 12.00. If the receipt prints a line total for qty > 1, divide it by qty.',
            },
            isLikelyShared: {
              type: 'boolean',
              description:
                'True for dishes normally shared across the table: rice, sides, appetisers, ' +
                'shared plates, jugs, condiments. False for individually ordered mains and drinks.',
            },
          },
        },
      },
      subtotalCents: {
        type: 'integer',
        description:
          'The pre-tax subtotal in INTEGER CENTS. If the receipt prints no subtotal line, ' +
          'sum the line items yourself.',
      },
      serviceChargeCents: {
        type: 'integer',
        description: 'Service charge in INTEGER CENTS. 0 if the receipt has no service charge.',
      },
      gstCents: {
        type: 'integer',
        description: 'GST/tax in INTEGER CENTS. 0 if the receipt shows no GST.',
      },
      discountCents: {
        type: 'integer',
        description:
          'Any discount or promotion in INTEGER CENTS, as a POSITIVE number. 0 if there is ' +
          'none. Report it here rather than as a negative item; it has already been deducted ' +
          'from totalCents.',
      },
      totalCents: {
        type: 'integer',
        description:
          'The final amount payable in INTEGER CENTS, after service charge, GST, and any ' +
          'discount or rounding line. This is the number the customer actually paid.',
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You transcribe receipt photos into structured data. You are precise and you never invent',
  'line items that are not visible in the image.',
  '',
  'Rules:',
  '- Every monetary value you return is an INTEGER NUMBER OF CENTS. Never a decimal.',
  '- Transcribe only ordered items as items. Subtotal, service charge, GST, discount, rounding,',
  '  total, tips, and payment lines are NOT items — they belong in their own fields.',
  '- Report a discount in discountCents as a positive number, never as a negative item.',
  '- Singapore receipts commonly stack a 10% service charge and then 9% GST. Report each as',
  '  printed; do not compute or reconcile them yourself.',
  '- Hawker and kopitiam receipts often have neither. Report 0 for both in that case.',
  '- If a value is genuinely illegible, use your best reading rather than 0, and prefer',
  '  consistency with the total.',
].join('\n');

const USER_PROMPT =
  'Transcribe this receipt. Call record_receipt exactly once with the complete contents.';

/**
 * Sends the image straight to the model. The caller streams the photo from
 * Telegram into memory — it is never written to disk or S3.
 */
export async function parseReceipt(image: ReceiptImage): Promise<ParsedReceipt> {
  try {
    return await attemptParse(image);
  } catch (err) {
    if (!(err instanceof VisionError)) throw err; // transport/API errors: let SQS retry
    // The same image bytes produce different output run to run — the longest
    // receipt in the test set variously returned an empty item list, then a
    // zero total, then parsed cleanly three times running. `temperature` is
    // deprecated on this model so the sampling can't be pinned down, which
    // makes one retry the only lever. It costs a single call against telling
    // someone their receipt is unreadable when it plainly isn't.
    log.warn('vision output failed validation, retrying once', { reason: err.message });
    return await attemptParse(image); // a second failure propagates
  }
}

async function attemptParse(image: ReceiptImage): Promise<ParsedReceipt> {
  const started = Date.now();
  const client = await visionClient();

  const response = await client.messages.create({
    model: config.visionModel(),
    max_tokens: 8000,
    // Do NOT add `temperature` here. Transcription would ideally be sampled at
    // 0 for reproducibility, but the parameter is deprecated on Sonnet 5 and
    // later — passing it returns 400 `temperature is deprecated for this
    // model`. Expect mild run-to-run variance on marginal receipts as a result.
    system: SYSTEM_PROMPT,
    tools: [RECEIPT_TOOL],
    // Forced: the model must produce the tool call, so there is no prose path
    // to handle and no "sometimes it answers in markdown" failure mode.
    tool_choice: { type: 'tool', name: RECEIPT_TOOL.name },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          { type: 'text', text: USER_PROMPT },
        ],
      },
    ],
  });

  // Token counts are the only visibility into vision spend, and input tokens
  // scale with image area — so a jump here usually means preprocessing stopped
  // cropping rather than prices getting longer.
  log.info('vision call complete', {
    model: response.model,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ms: Date.now() - started,
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError('the model declined to read this image');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new VisionError('receipt is too long to transcribe in one pass');
  }

  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') {
    throw new VisionError('no structured output returned');
  }

  return validate(block.input);
}

const GENERIC_HEADINGS = new Set([
  'bill',
  'receipt',
  'invoice',
  'tax invoice',
  'sales invoice',
  'order',
  'tax receipt',
  'customer copy',
]);

/**
 * Scrubs the merchant name, which is free text straight from the model and ends
 * up rendered as a heading.
 *
 * Observed in production: the field came back as `</antml.parameter>` — a
 * fragment of the model's own tool-call syntax leaking into a string value.
 * Anything tag-shaped is therefore stripped rather than trusted, which also
 * removes any chance of markup reaching the Telegram message (`esc` already
 * escapes it, but a heading full of escaped angle brackets is still garbage).
 *
 * Returns '' when nothing legible survives; callers substitute a generic name.
 */
function cleanMerchant(raw: unknown): string {
  if (typeof raw !== 'string') return '';

  const cleaned = raw
    .replace(/<[^>]*>/g, ' ') // anything tag-shaped, opening or closing
    // Control characters, written as escapes so the source stays greppable.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Require at least one letter or digit — punctuation alone is not a name.
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return '';

  // Some receipts print only a document type where the merchant would go, and
  // the model dutifully reports it. "Bill" tells the recipient nothing, so treat
  // it as absent and let the caller substitute a generic name.
  if (GENERIC_HEADINGS.has(cleaned.toLowerCase().replace(/[^a-z ]/g, '').trim())) return '';

  return cleaned.slice(0, 80);
}

/**
 * `strict: true` guarantees the shape, but not that the numbers are sane. A
 * receipt photo of a cat should not become a bill with a negative total.
 */
function validate(input: unknown): ParsedReceipt {
  const receipt = input as ParsedReceipt;

  if (!receipt || !Array.isArray(receipt.items)) {
    throw new VisionError('malformed output: no items array');
  }

  receipt.merchant = cleanMerchant(receipt.merchant);
  if (receipt.items.length === 0) {
    throw new VisionError("couldn't find any line items — is this a receipt?");
  }
  for (const field of [
    'subtotalCents',
    'serviceChargeCents',
    'gstCents',
    'discountCents',
    'totalCents',
  ] as const) {
    if (!isCents(receipt[field])) throw new VisionError(`malformed output: ${field}`);
  }
  if (receipt.totalCents <= 0) {
    throw new VisionError("couldn't read a total from this receipt");
  }
  for (const item of receipt.items) {
    if (!isCents(item.unitPriceCents) || !Number.isInteger(item.qty)) {
      throw new VisionError('malformed output: item price or quantity');
    }
    if (item.unitPriceCents < 0) throw new VisionError('malformed output: negative item price');
  }
  return receipt;
}
