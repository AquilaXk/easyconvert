import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { SAUVOLA_INK, SAUVOLA_PAPER } from '../src/lib/conversions/ocr-sauvola';
import { collectInk, estimateSkew, OCR_DESKEW_MAX_POINTS } from '../src/lib/conversions/ocr-text-metrics';

/**
 * Work contract of the skew search: every candidate angle projects every scored ink point once, so the number of
 * points is the cost of preparing a page. These tests pin the bound and check that the angle found from the bounded
 * sample is still the angle sharp's own rotation put into the page (an oracle that shares no code with the search).
 */

/** The most ink points a search may score, however dense the page: 73 candidate angles times this is the work. */
const MAX_SCORED_POINTS = 50_000;
const ANGLE_TOLERANCE_DEGREES = 0.15;

/** Dense text-like rows: `lines` bands of ink broken into words, like a 300 dpi page of body text. */
function denseTextPage(width: number, height: number, lines: number, bandHeight: number, pitch: number): Uint8Array {
  const page = new Uint8Array(width * height).fill(SAUVOLA_PAPER);
  for (let line = 0; line < lines; line++) {
    const top = 40 + line * pitch;
    for (let y = top; y < Math.min(height, top + bandHeight); y++) {
      for (let x = 60; x < width - 60; x++) {
        if (x % 10 < 8) page[y * width + x] = SAUVOLA_INK;
      }
    }
  }
  return page;
}

async function turned(page: Uint8Array, width: number, height: number, clockwise: number) {
  const { data, info } = await sharp(Buffer.from(page), { raw: { width, height, channels: 1 } })
    .rotate(clockwise, { background: '#ffffff' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const binary = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) binary[i] = data[i] < 128 ? SAUVOLA_INK : SAUVOLA_PAPER;
  return { binary, width: info.width, height: info.height };
}

function inkCount(binary: Uint8Array): number {
  let count = 0;
  for (const value of binary) if (value === SAUVOLA_INK) count++;
  return count;
}

describe('skew search work', () => {
  it('scores no more than the point budget on a page of solid ink', async () => {
    const result = await estimateSkew(new Uint8Array(1500 * 1500).fill(SAUVOLA_INK), 1500, 1500);
    expect(result.points).toBeLessThanOrEqual(MAX_SCORED_POINTS);
    expect(result.points).toBeLessThanOrEqual(OCR_DESKEW_MAX_POINTS);
  });

  it('scores no more than the point budget on a dense page, and keeps at least half of it', async () => {
    const page = denseTextPage(2400, 1800, 30, 36, 56);
    expect(inkCount(page)).toBeGreaterThan(1_000_000);
    const result = await estimateSkew(page, 2400, 1800);
    expect(result.points).toBeLessThanOrEqual(MAX_SCORED_POINTS);
    // An even sample, not a prefix of the page: the store is thinned by halves, so it is never emptier than half full.
    expect(result.points).toBeGreaterThanOrEqual(OCR_DESKEW_MAX_POINTS / 2);
  });

  it('scores every ink pixel of a sparse page', async () => {
    const page = denseTextPage(700, 420, 4, 6, 40);
    const ink = inkCount(page);
    expect(ink).toBeLessThan(MAX_SCORED_POINTS);
    expect((await estimateSkew(page, 700, 420)).points).toBe(ink);
  });

  for (const angle of [-8.1, -2.2, 0.7, 3.4, 6.2]) {
    it(`finds a dense page turned ${angle} degrees clockwise from the bounded sample`, async () => {
      const { binary, width, height } = await turned(denseTextPage(2000, 1500, 24, 34, 56), 2000, 1500, angle);
      const result = await estimateSkew(binary, width, height);
      expect(result.points).toBeLessThanOrEqual(MAX_SCORED_POINTS);
      expect(Math.abs(result.degrees - -angle)).toBeLessThanOrEqual(ANGLE_TOLERANCE_DEGREES);
      expect(result.improvement).toBeGreaterThan(1);
    });
  }
});

/** Deterministic generator so every run sees the same page. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A page with scattered ink at the given density, so no spacing of the sample lines up with its rows. */
function scatteredInkPage(width: number, height: number, density: number): Uint8Array {
  const random = mulberry32(7);
  const page = new Uint8Array(width * height).fill(SAUVOLA_PAPER);
  for (let i = 0; i < page.length; i++) if (random() < density) page[i] = SAUVOLA_INK;
  return page;
}

/** The ink pixels in reading order, relative to the page centre: the page read the plain way, with no thinning. */
function inkInReadingOrder(binary: Uint8Array, width: number, height: number): Array<[number, number]> {
  const all: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (binary[y * width + x] === SAUVOLA_INK) all.push([x - (width >> 1), y - (height >> 1)]);
  }
  return all;
}

describe('skew sample', () => {
  const width = 600;
  const height = 500;

  // 300 000 pixels at 0.8 density hold about 240 000 ink pixels: the store of 40 000 fills and is halved three times.
  it('is every 2^k-th ink pixel in reading order, with k the smallest spacing that fits the budget', async () => {
    const page = scatteredInkPage(width, height, 0.8);
    const ink = inkInReadingOrder(page, width, height);
    let spacing = 1;
    while (Math.ceil(ink.length / spacing) > OCR_DESKEW_MAX_POINTS) spacing *= 2;
    expect(spacing).toBeGreaterThanOrEqual(8);

    const sample = await collectInk(page, width, height);
    const expected = ink.filter((_, index) => index % spacing === 0);
    expect(sample.count).toBe(expected.length);
    const stored = Array.from({ length: sample.count }, (_, i): [number, number] => [sample.xs[i], sample.ys[i]]);
    expect(stored).toEqual(expected);
    // The sample reaches the end of the page, not only its first rows.
    expect(stored[stored.length - 1][1] + (height >> 1)).toBeGreaterThanOrEqual(height - 2);
  });

  it('is every 2^k-th ink pixel when the store is halved only once, and whole when it never fills', async () => {
    for (const density of [0.1, 0.3]) {
      const page = scatteredInkPage(width, height, density);
      const ink = inkInReadingOrder(page, width, height);
      let spacing = 1;
      while (Math.ceil(ink.length / spacing) > OCR_DESKEW_MAX_POINTS) spacing *= 2;
      const sample = await collectInk(page, width, height);
      const expected = ink.filter((_, index) => index % spacing === 0);
      expect(Array.from({ length: sample.count }, (_, i): [number, number] => [sample.xs[i], sample.ys[i]])).toEqual(expected);
    }
  });
});

describe('skew search hand-offs to the event loop', () => {
  /** setImmediate calls made while `work` runs: every hand-off of the search is one. */
  async function handOffsDuring<T>(work: () => Promise<T>): Promise<number> {
    const original = globalThis.setImmediate;
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: () => void) => original(callback)) as typeof setImmediate);
    try {
      await work();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it('hands over once per half a million points scored, not once per angle', async () => {
    const width = 600;
    const height = 500;
    const page = scatteredInkPage(width, height, 0.8);
    const sample = await collectInk(page, width, height);
    // The page is read in one chunk (524 288 pixels per hand-off cover more rows than it has). The search scores 40 angles on
    // every fourth point (-10 to 10 degrees in steps of half a degree, one of them already known), then 10 and 10 angles
    // on all of them: 30 sample sizes of work at the most. A hand-off follows each half million, and the remainder of
    // a stretch is dropped when it is taken, so at least one follows 30 sample sizes of 29 993 points.
    const handOffs = await handOffsDuring(() => estimateSkew(page, width, height));
    const perHandOff = 1 << 19;
    expect(handOffs).toBeGreaterThanOrEqual(Math.floor((29 * sample.count) / (perHandOff + sample.count)));
    expect(handOffs).toBeLessThanOrEqual(Math.ceil((30 * sample.count) / perHandOff));
    // Handing over at every angle would take 60.
    expect(handOffs).toBeLessThan(10);
  });
});
