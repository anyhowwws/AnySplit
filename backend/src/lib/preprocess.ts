import { Jimp, JimpMime } from 'jimp';
import { log } from './log.ts';
import type { ReceiptImage } from './vision.ts';

/**
 * Crops a photo down to just the receipt before it reaches the vision model.
 *
 * Claude downsizes every image to a fixed maximum long edge before reading it.
 * A phone photo where the receipt occupies 40-70% of the frame therefore spends
 * most of that pixel budget on the table, and the small print is left with too
 * few pixels to resolve. Measured over 9 real receipts, cropping alone took
 * subtotal reconciliation from 3/9 to 5/9 on Haiku 4.5 and 6/9 to 8/9 on
 * Sonnet 5 — and because the cropped image is smaller, it costs *less*.
 *
 * Rotation, by contrast, made no measurable difference (3/9 either way), so
 * there is deliberately no deskew or orientation guessing here. Jimp applies
 * the EXIF orientation tag on read, which is all that turned out to matter.
 *
 * This is a best-effort enhancement: any failure falls back to the original
 * image rather than breaking the parse.
 */

/** Width the mask analysis runs at. Full resolution would be needlessly slow. */
const ANALYSIS_WIDTH = 700;

/** Pixels of slack around the detected receipt, in analysis-space. */
const PAD = 8;

/**
 * Reject a detection covering less than this fraction of the frame. A tiny blob
 * is a specular highlight or a napkin, not the receipt, and cropping to it would
 * throw away the actual bill.
 */
const MIN_AREA_FRACTION = 0.12;

export interface CropResult {
  image: ReceiptImage;
  /** False when detection failed or was rejected; the original is returned. */
  cropped: boolean;
  /** Fraction of the original frame kept. 1 when not cropped. */
  keptFraction: number;
}

export async function cropToReceipt(input: ReceiptImage): Promise<CropResult> {
  const untouched: CropResult = { image: input, cropped: false, keptFraction: 1 };

  try {
    const img = await Jimp.read(Buffer.from(input.data, 'base64'));
    const { width, height } = img.bitmap;

    const box = detectReceipt(img);
    if (!box) return untouched;

    const areaFraction = (box.w * box.h) / (width * height);
    if (areaFraction < MIN_AREA_FRACTION) {
      log.info('receipt detection rejected as implausibly small', { areaFraction });
      return untouched;
    }
    // Already tight — re-encoding would cost quality for no benefit.
    if (areaFraction > 0.97) return untouched;

    const cropped = img.clone().crop(box);
    const buffer = await cropped.getBuffer(JimpMime.jpeg, { quality: 92 });

    return {
      image: { data: buffer.toString('base64'), mediaType: 'image/jpeg' },
      cropped: true,
      keptFraction: areaFraction,
    };
  } catch (err) {
    // Never let a preprocessing bug cost us the parse.
    log.warn('receipt crop failed, using original image', {
      err: err instanceof Error ? err.message : String(err),
    });
    return untouched;
  }
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Jimp's instance type is deeply generic over its format plugins, and
 * `InstanceType<typeof Jimp>` produces a structurally different (incompatible)
 * instantiation. Inferring from `read` gives exactly what we actually hold.
 */
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

/**
 * Finds the receipt as the largest bright, low-saturation blob.
 *
 * Paper is both bright and close to neutral grey, which separates it from wood,
 * fabric, and skin. The brightness threshold is relative to the image's own 90th
 * percentile rather than absolute, so a dim restaurant doesn't defeat it.
 */
function detectReceipt(source: JimpImage): Box | null {
  const scale = ANALYSIS_WIDTH / source.bitmap.width;
  if (scale >= 1) return null; // already small; not worth cropping

  const small = source.clone().resize({ w: ANALYSIS_WIDTH });
  const { width: w, height: h, data } = small.bitmap;

  const value = new Float32Array(w * h);
  const saturation = new Float32Array(w * h);

  for (let i = 0, p = 0; i < value.length; i++, p += 4) {
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    value[i] = max / 255;
    saturation[i] = max > 0 ? (max - min) / max : 0;
  }

  /*
   * Hysteresis thresholding, the same idea Canny uses for edges.
   *
   * A single brightness threshold assumes the whole sheet is evenly lit. Real
   * photos are not: a receipt lying under a lamp is bright at one end and in
   * shadow at the other. A threshold high enough to reject the table also
   * rejects the shadowed end of the paper — which silently amputated the
   * totals block on a real receipt, and the model then invented a total rather
   * than reporting one it could not see.
   *
   * So: seed only on confidently-bright paper, then grow through *connected*
   * dimmer pixels. Shadowed paper joins the region because it touches lit
   * paper; a bright patch of background elsewhere never does.
   */
  const peak = percentile(value, 0.9);
  const seedThreshold = Math.max(0.45, peak * 0.72);
  const growThreshold = Math.max(0.22, peak * 0.45);

  const seed = new Uint8Array(w * h);
  const grow = new Uint8Array(w * h);
  for (let i = 0; i < seed.length; i++) {
    const v = value[i]!;
    const s = saturation[i]!;
    if (v > seedThreshold && s < 0.35) seed[i] = 1;
    // Laxer on both axes: shadow darkens paper and shifts its hue slightly.
    if (v > growThreshold && s < 0.45) grow[i] = 1;
  }

  return largestSeededComponentBox(seed, grow, w, h, scale, source.bitmap.width, source.bitmap.height);
}

function percentile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Flood-fills the `grow` mask starting only from `seed` pixels, and keeps the
 * bounding box of the largest resulting region.
 *
 * Uses an explicit typed-array stack — a recursive fill would blow the call
 * stack on a region this size.
 */
function largestSeededComponentBox(
  seed: Uint8Array,
  grow: Uint8Array,
  w: number,
  h: number,
  scale: number,
  fullW: number,
  fullH: number,
): Box | null {
  const seen = new Uint8Array(grow.length);
  const stack = new Int32Array(grow.length);

  let bestSize = 0;
  let best: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  for (let start = 0; start < seed.length; start++) {
    // Only confident paper starts a region; growth then spreads through `grow`.
    if (seed[start] === 0 || grow[start] === 0 || seen[start] === 1) continue;

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;

    let size = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;

    while (top > 0) {
      const idx = stack[--top]!;
      const x = idx % w;
      const y = (idx - x) / w;

      size++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) push(idx - 1);
      if (x < w - 1) push(idx + 1);
      if (y > 0) push(idx - w);
      if (y < h - 1) push(idx + w);
    }

    if (size > bestSize) {
      bestSize = size;
      best = { minX, minY, maxX, maxY };
    }

    function push(next: number): void {
      if (grow[next] === 1 && seen[next] === 0) {
        seen[next] = 1;
        stack[top++] = next;
      }
    }
  }

  if (!best) return null;

  const x = Math.max(0, Math.floor((best.minX - PAD) / scale));
  const y = Math.max(0, Math.floor((best.minY - PAD) / scale));
  const right = Math.min(fullW, Math.ceil((best.maxX + PAD) / scale));
  const bottom = Math.min(fullH, Math.ceil((best.maxY + PAD) / scale));

  const box = { x, y, w: right - x, h: bottom - y };
  return box.w > 0 && box.h > 0 ? box : null;
}
