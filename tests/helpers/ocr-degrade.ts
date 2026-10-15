import sharp from 'sharp';

/**
 * Seeded degradations of a clean page, so a held-out set can be built at test time from the small
 * committed pages (tests/fixtures/ocr-calibration). Each one is deterministic: the same page and
 * the same seed always produce the same pixels.
 */

const GRAY_CHANNELS = 1;
const MAX_BYTE = 255;
const UINT32_RANGE = 4_294_967_296;
const MULBERRY_STEP = 0x6d2b79f5;
const BOX_MULLER_EPSILON = 1e-12;

/** A small seeded generator (mulberry32); returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_STEP) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

async function toGray(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function encode(data: Uint8Array, width: number, height: number): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: GRAY_CHANNELS } }).png().toBuffer();
}

/** Adds zero-mean Gaussian noise of standard deviation `sigma` (gray levels) to every pixel. */
export async function addNoise(png: Buffer, sigma: number, seed: number): Promise<Buffer> {
  const { data, width, height } = await toGray(png);
  const random = seededRandom(seed);
  const noisy = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const u1 = Math.max(random(), BOX_MULLER_EPSILON);
    const u2 = random();
    const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    noisy[i] = Math.min(MAX_BYTE, Math.max(0, Math.round(data[i] + sigma * gaussian)));
  }
  return encode(noisy, width, height);
}

/** Scales the page to `dpi` as if it had been scanned at that resolution (the clean page is 300 dpi). */
export async function atDpi(png: Buffer, dpi: number, sourceDpi = 300): Promise<Buffer> {
  const { width } = await sharp(png).metadata();
  return sharp(png)
    .resize({ width: Math.max(1, Math.round(((width ?? 1) * dpi) / sourceDpi)), kernel: sharp.kernel.lanczos3 })
    .greyscale()
    .png()
    .toBuffer();
}

export async function blurred(png: Buffer, sigma: number): Promise<Buffer> {
  return sharp(png).greyscale().blur(sigma).png().toBuffer();
}

/** Compresses the gray range to `contrast` (0..1) around mid-gray, as a faded scan does. */
export async function fadedTo(png: Buffer, contrast: number): Promise<Buffer> {
  const { data, width, height } = await toGray(png);
  const mid = MAX_BYTE / 2;
  const faded = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) faded[i] = Math.round(mid + (data[i] - mid) * contrast);
  return encode(faded, width, height);
}

export interface Degradation {
  name: string;
  apply: (png: Buffer, seed: number) => Promise<Buffer>;
}
