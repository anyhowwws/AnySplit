import type { Bot, Context } from 'grammy';
import type { Bill } from '../../../shared/types.ts';
import { DEFAULT_CURRENCY } from '../../../shared/currency.ts';
import { config } from './config.ts';
import { getBill, putBill, recordUse, ttlFromNow } from './db.ts';
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
import { newBillId, parseStartPayload } from './ids.ts';
import { deriveBill } from './receipt.ts';
import { addLogContext, errorFields, log } from './log.ts';
import { enqueueParse } from './queue.ts';
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

  const billId = newBillId();
  // From here on every line in this request carries the billId, including ones
  // emitted deep inside the Telegram client.
  addLogContext({ billId });

  const bill: Bill = {
    billId,
    adminId: ctx.from.id,
    merchant: '',
    // Overwritten once the vision call reads the receipt's actual currency;
    // this placeholder only needs to satisfy the type until then.
    currency: DEFAULT_CURRENCY,
    subtotal: 0,
    total: 0,
    factor: 1,
    status: 'parsing',
    units: [],
    shares: [],
    ttl: ttlFromNow(),
  };

  await putBill(bill);
  const placeholder = await ctx.reply('Reading receipt…');

  try {
    await enqueueParse({
      billId,
      fileId: ref.fileId,
      mediaType: ref.mediaType,
      chatId: placeholder.chat.id,
      messageId: placeholder.message_id,
    });
    log.info('parse enqueued', { admin: await userRef(ctx.from.id) });
    // Counted once the work is actually under way, so an enqueue that failed
    // isn't recorded as somebody having used the bot.
    await recordUse(ctx.from.id);
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
 * Creates a bill from a canned receipt, skipping the photo and the vision call.
 *
 * Everything downstream is the real thing: the fixture goes through the same
 * `deriveBill` the parser uses, lands in DynamoDB the same way, and opens the
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

  const billId = newBillId();
  addLogContext({ billId, fixture: name });

  const derived = deriveBill(fixture.receipt);
  const bill: Bill = {
    billId,
    adminId: ctx.from.id,
    status: 'review',
    shares: [],
    ttl: ttlFromNow(),
    ...derived,
  };

  await putBill(bill);
  log.info('test bill created', { fixture: name, admin: await userRef(ctx.from.id) });

  await ctx.reply(`🧪 <i>Test receipt — nothing was read, no vision call made.</i>`, {
    parse_mode: 'HTML',
  });
  await ctx.reply(parsedSummary(bill), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: splitButtonLabel(bill), web_app: { url: miniAppUrl(billId) } }]],
    },
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
