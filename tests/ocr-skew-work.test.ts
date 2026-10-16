import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { SAUVOLA_INK, SAUVOLA_PAPER } from '../src/lib/conversions/ocr-sauvola';
import { estimateSkew, OCR_DESKEW_MAX_POINTS } from '../src/lib/conversions/ocr-text-metrics';

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
