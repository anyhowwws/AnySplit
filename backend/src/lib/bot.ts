import type { Bot, Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Bill, Receipt } from '../../../shared/types.ts';
import { DEFAULT_CURRENCY } from '../../../shared/currency.ts';
import { FIRST_RECEIPT_ID, MAX_RECEIPTS, receiptsOf } from '../../../shared/receipts.ts';
import { config } from './config.ts';
import { addReceipt, getBill, putBill, recordUse, setAttach, takeAttach, ttlFromNow } from './db.ts';
import {
  HELP_TEXT,
  START_TEXT,
  esc,
  parsedSummary,
  privacyText,
  rateLimitText,
  recipientBreakdown,
  splitButtonLabel,
} from './format.ts';
import { claimParse } from './ratelimit.ts';
import { FIXTURES, fixtureNames } from './fixtures.ts';
import { newBillId, newReceiptId, parseStartPayload } from './ids.ts';
import { deriveReceipt } from './receipt.ts';
import { addLogContext, errorFields, log } from './log.ts';
import { enqueueParse } from './queue.ts';
import type { ImageRef } from './telegram.ts';
import { imageFrom, miniAppUrl, privacyUrl } from './telegram.ts';
import { userRef } from './userref.ts';

/**
 * Registers every bot handler.
 *
 * Everything here must finish fast: Telegram retries webhooks that don't get a
 * 200 within a few seconds, so the only work done inline is a DynamoDB write, a
 * reply, and an SQS enqueue. The vision call happens in the parser Lambda.
 */
export function registerHandlers(bot: Bot): void {
  bot.command('start', async (ctx) => {
    if (!isPrivate(ctx)) return;

    const payload = ctx.match?.trim();
    if (!payload) {
      // Telegram fires /start on first open, so this is the welcome. /help
      // carries the detail; repeating it here would bury the one instruction
      // that matters.
      await ctx.reply(START_TEXT, { parse_mode: 'HTML' });
      return;
    }
    // Legacy deep links, forwarded before the per-bill link was retired.
    await showShare(ctx, payload);
  });

  bot.command('help', async (ctx) => {
    if (!isPrivate(ctx)) return;
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.command('privacy', async (ctx) => {
    if (!isPrivate(ctx)) return;
    await ctx.reply(privacyText(privacyUrl()), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command('test', async (ctx) => {
    if (!isPrivate(ctx)) return;
    await handleTest(ctx, ctx.match?.trim() ?? '');
  });

  bot.callbackQuery(/^add:([A-Za-z0-9_-]{12})$/, handleAddReceipt);
  // Anything else — a button from a deploy that no longer exists. Answer it so
  // the client stops spinning.
  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery());

  bot.on('message:photo', handleImage);
  bot.on('message:document', handleImage);

  // Anything else in a DM: nudge, don't ignore silently.
  bot.on('message:text', async (ctx) => {
    if (!isPrivate(ctx)) return;
    await ctx.reply('Send me a photo of a receipt and I\'ll split it. /help for details.');
  });
}

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

async function handleImage(ctx: Context): Promise<void> {
  if (!isPrivate(ctx) || !ctx.msg || !ctx.from) return;

  const ref = imageFrom(ctx.msg);
  if (!ref) {
    await ctx.reply("That file isn't an image I can read. Send a photo, JPEG, or PNG.");
    return;
  }

  // Before the bill exists and before anything is queued: a refusal here costs
  // one conditional write, where a refusal after enqueueing would already have
  // paid for the vision call.
  const refused = await claimParse(ctx.from.id);
  if (refused) {
    log.warn('rate limited', {
      scope: refused.scope,
      admin: await userRef(ctx.from.id),
    });
    await ctx.reply(rateLimitText(refused));
    return;
  }

  // A photo sent after "Add another receipt" joins that bill instead.
  const target = await takeAttach(ctx.from.id);
  if (target) {
    const receipt = placeholderReceipt(newReceiptId());
    const added = await attachReceipt(ctx, target, receipt);
    if (added) {
      await startParse(ctx, target, receipt.receiptId, ref, `Reading receipt ${added}…`);
      return;
    }
  }

  const billId = newBillId();
  // From here on every line in this request carries the billId, including ones
  // emitted deep inside the Telegram client.
  addLogContext({ billId });

  const bill: Bill = {
    billId,
    adminId: ctx.from.id,
    receipts: { [FIRST_RECEIPT_ID]: { ...placeholderReceipt(FIRST_RECEIPT_ID), seq: 0 } },
    status: 'parsing',
    shares: [],
    ttl: ttlFromNow(),
  };

  await putBill(bill);
  await startParse(ctx, billId, FIRST_RECEIPT_ID, ref, 'Reading receipt…');
}

/** A receipt whose photo hasn't been read yet. */
function placeholderReceipt(receiptId: string): Receipt {
  return {
    receiptId,
    // Overwritten by attachReceipt for a later receipt, which knows the order.
    seq: 0,
    status: 'parsing',
    merchant: '',
    // Overwritten once the vision call reads the receipt's actual currency;
    // this placeholder only needs to satisfy the type until then.
    currency: DEFAULT_CURRENCY,
    subtotal: 0,
    total: 0,
    factor: 1,
    units: [],
  };
}

/**
 * Adds `receipt` to the bill an "Add another receipt" tap pointed at. Returns
 * its position on the bill (2 for the second receipt), or null — having told
 * the admin why — when the photo should start a new bill instead.
 */
async function attachReceipt(ctx: Context, billId: string, receipt: Receipt): Promise<number | null> {
  addLogContext({ billId, receiptId: receipt.receiptId });

  const bill = await getBill(billId);
  // The marker is only ever set for the bill's own admin; this is belt and braces.
  if (!bill || bill.adminId !== ctx.from?.id) {
    await ctx.reply("That bill has expired, so this receipt starts a new one.");
    return null;
  }

  const existing = receiptsOf(bill);
  const placed = { ...receipt, seq: Math.max(...existing.map((r) => r.seq)) + 1 };
  const outcome = await addReceipt(billId, placed, MAX_RECEIPTS);
  if (outcome === 'missing') {
    await ctx.reply("That bill has expired, so this receipt starts a new one.");
    return null;
  }
  if (outcome === 'full') {
    await ctx.reply(
      `That bill already has ${MAX_RECEIPTS} receipts, the most one can hold, ` +
        'so this one starts a new bill.',
    );
    return null;
  }
  log.info('receipt added to bill', { receipts: existing.length + 1 });
  return existing.length + 1;
}

/** Posts the "Reading…" placeholder and queues the photo for the parser. */
async function startParse(
  ctx: Context,
  billId: string,
  receiptId: string,
  ref: ImageRef,
  placeholderText: string,
): Promise<void> {
  const placeholder = await ctx.reply(placeholderText);

  try {
    await enqueueParse({
      billId,
      receiptId,
      fileId: ref.fileId,
      mediaType: ref.mediaType,
      chatId: placeholder.chat.id,
      messageId: placeholder.message_id,
    });
    log.info('parse enqueued', { admin: await userRef(ctx.from?.id) });
    // Counted once the work is actually under way, so an enqueue that failed
    // isn't recorded as somebody having used the bot.
    await recordUse(ctx.from?.id);
  } catch (err) {
    log.error('enqueue failed', errorFields(err));
    await ctx.api.editMessageText(
      placeholder.chat.id,
      placeholder.message_id,
      "Something went wrong before I could read that. Try sending it again.",
    );
  }
}

/**
 * "➕ Add another receipt": arms the marker that makes the admin's next photo
 * join this bill. The photo arrives as an ordinary message, so this can't
 * attach anything itself — only remember where the next one goes.
 */
async function handleAddReceipt(ctx: Context): Promise<void> {
  const billId = (ctx.match as RegExpMatchArray)[1]!;
  addLogContext({ billId });
  if (!ctx.from) return;

  const bill = await getBill(billId);
  if (!bill || bill.adminId !== ctx.from.id) {
    await ctx.answerCallbackQuery({
      text: 'That bill has expired. Send a photo to start a new one.',
      show_alert: true,
    });
    return;
  }
  const count = receiptsOf(bill).length;
  if (count >= MAX_RECEIPTS) {
    await ctx.answerCallbackQuery({
      text: `This bill already has ${MAX_RECEIPTS} receipts, the most one can hold.`,
      show_alert: true,
    });
    return;
  }

  await setAttach(ctx.from.id, billId);
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `Send me receipt ${count + 1} and I'll add it to this bill. ` +
      'A photo sent more than 15 minutes from now starts a new bill instead.',
  );
  log.info('add receipt armed', { receipts: count });
}

/**
 * The buttons under a parsed receipt: open the Mini App, and add another
 * receipt to the same bill — the latter only while there's room for one.
 */
export function billKeyboard(bill: Bill): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup['inline_keyboard'] = [
    [{ text: splitButtonLabel(bill), web_app: { url: miniAppUrl(bill.billId) } }],
  ];
  if (receiptsOf(bill).length < MAX_RECEIPTS) {
    rows.push([{ text: '➕ Add another receipt', callback_data: `add:${bill.billId}` }]);
  }
  return { inline_keyboard: rows };
}

/**
 * Creates a bill from a canned receipt, skipping the photo and the vision call.
 *
 * Everything downstream is the real thing: the fixture goes through the same
 * `deriveReceipt` the parser uses, lands in DynamoDB the same way, and opens the
 * same Mini App. Only the model call is skipped — which is the part that costs
 * money on every iteration and is the least likely thing to be broken.
 *
 * Restricted to a single Telegram account via TEST_USER_ID. An empty setting
 * disables the command outright, so a deployment that forgets to configure it
 * fails closed rather than handing fixtures to everyone. Unauthorised callers
 * get silence — the same as any unrecognised command — rather than a denial
 * that confirms the command exists.
 *
 * Also absent from /setcommands, and every message it produces is labelled so a
 * mock bill can't be mistaken for a real one.
 */
async function handleTest(ctx: Context, name: string): Promise<void> {
  if (!ctx.from) return;

  const allowed = config.testUserId();
  if (allowed === '' || String(ctx.from.id) !== allowed) {
    log.warn('test command refused', {
      configured: allowed !== '',
      caller: await userRef(ctx.from.id),
    });
    return;
  }

  const fixture = FIXTURES[name];
  if (!fixture) {
    const menu = fixtureNames()
      .map((key) => `<code>/test ${key}</code> — ${esc(FIXTURES[key]!.description)}`)
      .join('\n');
    await ctx.reply(`<b>Test receipts</b>\n\n${menu}`, { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply(`🧪 <i>Test receipt — nothing was read, no vision call made.</i>`, {
    parse_mode: 'HTML',
  });

  // After "Add another receipt", the fixture joins that bill like a photo
  // would — so a multi-receipt bill can be built without a vision call.
  const target = await takeAttach(ctx.from.id);
  if (target) {
    addLogContext({ fixture: name });
    const receipt = { ...deriveReceipt(fixture.receipt, newReceiptId(), 0), status: 'review' as const };
    const position = await attachReceipt(ctx, target, receipt);
    const bill = position ? await getBill(target) : null;
    if (position && bill) {
      log.info('test receipt added', { fixture: name });
      await ctx.reply(parsedSummary(receipt, position), {
        parse_mode: 'HTML',
        reply_markup: billKeyboard(bill),
      });
      return;
    }
  }

  const billId = newBillId();
  addLogContext({ billId, fixture: name });

  const receipt = deriveReceipt(fixture.receipt, FIRST_RECEIPT_ID, 0);
  const bill: Bill = {
    billId,
    adminId: ctx.from.id,
    receipts: { [receipt.receiptId]: receipt },
    status: 'review',
    shares: [],
    ttl: ttlFromNow(),
  };

  await putBill(bill);
  log.info('test bill created', { fixture: name, admin: await userRef(ctx.from.id) });

  await ctx.reply(parsedSummary(receipt), {
    parse_mode: 'HTML',
    reply_markup: billKeyboard(bill),
  });
}

/**
 * A recipient tapped a deep link. Handles expired bills, unfinalised bills, and
 * hand-mangled payloads without ever showing a stack trace.
 */
async function showShare(ctx: Context, payload: string): Promise<void> {
  const parsed = parseStartPayload(payload);
  if (!parsed) {
    await ctx.reply("That link doesn't look right. Ask whoever sent it to resend it.");
    return;
  }

  addLogContext({ billId: parsed.billId, shareIdx: parsed.shareIdx });

  const bill = await getBill(parsed.billId);
  if (!bill) {
    // Reached only by links forwarded before the deep link was retired, or by a
    // bill abandoned before it was sent. Either way there is nothing to show.
    await ctx.reply(
      "I don't have that bill any more — AnySplit deletes each one as soon as its " +
        'messages go out. The message you were forwarded has the full breakdown in it.',
    );
    return;
  }

  if (bill.status !== 'final') {
    // The admin shared a link before finalising, or is still assigning items.
    if (bill.adminId === ctx.from?.id) {
      await ctx.reply('This bill isn\'t split yet.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: splitButtonLabel(bill), web_app: { url: miniAppUrl(bill.billId) } }],
          ],
        },
      });
    } else {
      await ctx.reply("This bill hasn't been split yet. Check back shortly.");
    }
    return;
  }

  const share = bill.shares.find((s) => s.idx === parsed.shareIdx);
  if (!share) {
    await ctx.reply("I can't find that person on this bill. Ask for a fresh link.");
    return;
  }

  log.info('share viewed');
  // bill.payee carries no phone by design; the number lived only in the
  // forwarded message.
  await ctx.reply(recipientBreakdown(bill, share, bill.payee), { parse_mode: 'HTML' });
}

/** Used by the parser Lambda when a parse fails, so the wording lives in one place. */
export function parseFailureText(reason: string): string {
  return [
    "I couldn't read that receipt.",
    '',
    esc(reason),
    '',
    'A flatter angle, more light, or sending it as a file instead of a photo usually fixes it.',
  ].join('\n');
}
