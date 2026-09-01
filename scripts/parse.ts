/**
 * Phase 1 harness: prove the parse before building anything around it.
 *
 * Reads local receipt images, runs the same vision call the parser Lambda uses,
 * and reports whether the line items reconcile to the printed subtotal. No AWS,
 * no Telegram.
 *
 *   cd backend && npm install
 *   node --env-file=../.env --experimental-strip-types ../scripts/parse.ts ../receipts/*.jpg
 *
 * Exit criteria from SPEC.md: subtotal reconciles on 9 of 10 real receipts
 * without manual fixes. Collect the awkward cases too — a hawker chit with no
 * tax lines, Chinese item names, a discount line, 30+ items, one crumpled.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { deriveFactor, expandUnits, reconcilesToSubtotal, subtotalOf } from '../backend/src/lib/calc.ts';
import { formatCents } from '../backend/src/lib/money.ts';
import { config } from '../backend/src/lib/config.ts';
import { cropToReceipt } from '../backend/src/lib/preprocess.ts';
import { type ImageMediaType, parseReceipt } from '../backend/src/lib/vision.ts';

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Preprocessing is on by default so this harness measures the same path the
// parser Lambda runs. `--raw` disables it, which is how the crop was A/B'd.
const raw = process.argv.includes('--raw');
const files = process.argv.slice(2).filter((a) => a !== '--raw');
if (files.length === 0) {
  console.error('usage: parse.ts [--raw] <image> [image...]');
  process.exit(1);
}

let reconciled = 0;
let failed = 0;

for (const file of files) {
  const label = basename(file);
  const mediaType = MEDIA_TYPES[extname(file).toLowerCase()];
  if (!mediaType) {
    console.error(`${label}: unsupported extension, skipping`);
    continue;
  }

  const started = Date.now();
  try {
    const data = (await readFile(file)).toString('base64');
    const source = { data, mediaType };
    const prepped = raw ? { image: source, cropped: false, keptFraction: 1 } : await cropToReceipt(source);
    const receipt = await parseReceipt(prepped.image);

    const units = expandUnits(receipt);
    const unitSum = subtotalOf(units);
    const ok = reconcilesToSubtotal(receipt);
    const factor = deriveFactor(unitSum, receipt.totalCents);

    if (ok) reconciled++;

    const cropNote = prepped.cropped
      ? `cropped to ${(prepped.keptFraction * 100).toFixed(0)}%`
      : 'uncropped';
    console.log(`\n${'='.repeat(60)}`);
    console.log(
      `${label}  (${Date.now() - started}ms, ${cropNote})  ${ok ? '✓ reconciles' : '✗ MISMATCH'}`,
    );
    console.log(`${'='.repeat(60)}`);
    console.log(`merchant: ${receipt.merchant || '(none read)'}`);
    console.log('');

    for (const item of receipt.items) {
      const qty = item.qty > 1 ? `${item.qty}× ` : '   ';
      const shared = item.isLikelyShared ? '  [shared?]' : '';
      const expansion = item.displayName !== item.rawName ? `  (${item.rawName})` : '';
      console.log(
        `  ${qty}${item.displayName.padEnd(28)} ${formatCents(item.unitPriceCents * item.qty).padStart(9)}${shared}${expansion}`,
      );
    }

    console.log('');
    console.log(`  items sum      ${formatCents(unitSum).padStart(9)}`);
    console.log(`  printed sub    ${formatCents(receipt.subtotalCents).padStart(9)}`);
    console.log(`  discount       ${formatCents(receipt.discountCents).padStart(9)}`);
    console.log(`  service        ${formatCents(receipt.serviceChargeCents).padStart(9)}`);
    console.log(`  gst            ${formatCents(receipt.gstCents).padStart(9)}`);
    console.log(`  total          ${formatCents(receipt.totalCents).padStart(9)}`);
    console.log(`  factor         ${factor.toFixed(4)}  (+${((factor - 1) * 100).toFixed(1)}%)`);
    console.log(`  units          ${units.length}`);

    if (!ok) {
      const delta = unitSum - receipt.subtotalCents;
      console.log('');
      console.log(`  ⚠️  items are ${formatCents(Math.abs(delta))} ${delta > 0 ? 'over' : 'under'} the printed subtotal`);
    }
  } catch (err) {
    failed++;
    console.log(`\n${label}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const attempted = reconciled + failed + (files.length - reconciled - failed);
console.log(`\n${'-'.repeat(60)}`);
console.log(`reconciled: ${reconciled}/${attempted}   hard failures: ${failed}`);
// Read through config rather than re-stating a default here — a stale literal
// silently mislabels which model the run actually used.
console.log(`model: ${config.visionModel()}   preprocessing: ${raw ? 'off (--raw)' : 'on'}`);
