import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { findRsvgConvert, hasSvgText } from '../src/lib/conversions/svg-text-outlines';
import { emfOracleRecords } from './helpers/metafile-oracle';
import { oracleTest } from './helpers/oracle-test';
import { sofficeConvert } from './helpers/soffice-convert';
import { skipUnless } from './helpers/strict-skip';

/**
 * An SVG with text is written as an EMF or WMF with the text as outlines (the metafile writers carry geometry only): the sweep of 2026-11-20 refused
 * `label.svg` ("SVG element <text> is not supported by metafile encoders"). The words are judged by an independent reader: LibreOffice draws the
 * metafile and the rows of ink are counted (one band for each line of text).
 */

const needsRsvg = skipUnless('rsvg-convert (librsvg2-bin)', findRsvgConvert() !== null);
const LINES = ['Harbour survey', 'Northern shore 2026', 'Eleven jetties mapped'];
const LABEL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="140" viewBox="0 0 400 140"><rect width="400" height="140" fill="#ffffff"/>' +
  LINES.map((line, index) => `<text x="12" y="${42 + 40 * index}" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#111111">${line}</text>`).join('') +
  '</svg>';
const INK_THRESHOLD = 128;
const CONVERSION_TIMEOUT_MS = 120_000;

/** The number of separate bands of rows that hold dark pixels, and how many pixels are dark. */
async function inkBands(png: Buffer): Promise<{ bands: number; ink: number }> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let bands = 0;
  let ink = 0;
  let inBand = false;
  for (let row = 0; row < info.height; row++) {
    let rowInk = 0;
    for (let column = 0; column < info.width; column++) if (data[row * info.width + column] < INK_THRESHOLD) rowInk++;
    ink += rowInk;
    if (rowInk > 0 && !inBand) bands++;
    inBand = rowInk > 0;
  }
  return { bands, ink };
}

describe('hasSvgText', () => {
  it('finds a text element under any prefix and no other element', () => {
    expect(hasSvgText('<svg><text x="1">a</text></svg>')).toBe(true);
    expect(hasSvgText('<svg xmlns:s="http://www.w3.org/2000/svg"><s:text>a</s:text></svg>')).toBe(true);
    expect(hasSvgText('<svg><textPath href="#p">a</textPath><rect/></svg>')).toBe(false);
    expect(hasSvgText('<svg><rect width="1" height="1"/></svg>')).toBe(false);
  });
});

describe.skipIf(needsRsvg)('SVG text written to metafiles', () => {
  it.each(['emf', 'wmf'] as const)('writes the text of a drawing into a %s that is far larger than its rectangle', async (target) => {
    const withText = await dispatchConversion(Buffer.from(LABEL_SVG, 'utf-8'), 'svg', target, {}, 'label.svg');
    const withoutText = await dispatchConversion(Buffer.from(LABEL_SVG.replace(/<text[^]*<\/text>/, ''), 'utf-8'), 'svg', target, {}, 'plain.svg');
    expect(withText.size).toBeGreaterThan(withoutText.size + 3000);
  }, CONVERSION_TIMEOUT_MS);

  oracleTest('shows three lines of text when LibreOffice draws the WMF and the EMF', ['soffice'], async () => {
    for (const target of ['emf', 'wmf'] as const) {
      const result = await dispatchConversion(Buffer.from(LABEL_SVG, 'utf-8'), 'svg', target, {}, 'label.svg');
      const png = sofficeConvert(result.buffer, `label.${target}`, 'png', (output) => output.read());
      const { bands, ink } = await inkBands(png);
      expect({ target, bands }).toEqual({ target, bands: LINES.length });
      expect(ink).toBeGreaterThan(500);
    }
  }, CONVERSION_TIMEOUT_MS);

  it('leaves a drawing without text to the geometry writers as before', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="20" height="20" fill="#336699"/></svg>';
    const result = await dispatchConversion(Buffer.from(svg, 'utf-8'), 'svg', 'emf', {}, 'plain.svg');
    expect(emfOracleRecords(result.buffer).hasPolygon16).toBe(true);
  });
});
