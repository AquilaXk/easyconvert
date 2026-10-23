import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFontProgramToUnicode } from '../src/lib/conversions/pdf-font-tounicode';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';
import { withoutTables } from './helpers/sfnt-tables';

/**
 * The /W array of a CIDFont is read for the Arial and Times New Roman fonts whose program names no glyph. A /W built to be
 * expensive (one large array object named by thousands of entries, entries whose start lies far below the CIDs asked for,
 * one /W shared by the 64 fonts the pass reads) must cost time linear in its size, and a /W past the pass's step budget
 * leaves its fonts as they were.
 */

const DEJAVU = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.ttf'));
const BARE_TRUETYPE = withoutTables(DEJAVU, 'cmap', 'post');
/** The CIDs of 'Report No. 02-083' by the Macintosh order and their Arial widths, as Acrobat Distiller writes them in govdocs1-003205.pdf. */
const ARIAL_CIDS = [53, 72, 83, 82, 85, 87, 3, 49, 82, 17, 3, 19, 21, 16, 19, 27, 22];
const ARIAL_WIDTHS = new Map([
  [3, 278], [16, 333], [17, 278], [19, 556], [21, 556], [22, 556], [27, 556], [49, 722], [53, 722], [72, 556], [82, 556], [83, 556], [85, 333], [87, 278],
]);
const FONT_COUNT = 64;
/** Far below the CIDs asked for, and an integer: pdfjs reads such an entry, and it fills nothing. */
const FAR_BELOW = -1_000_000_000;
const BOUND_MS = 2_000;
const TIMEOUT_MS = 120_000;

/** `cid [width]` for each listed CID, the form the distillers write. */
const listed = (widths: Map<number, number>): string => [...widths].map(([cid, width]) => `${cid} [${width}]`).join(' ');

/** The widths of the CIDs from 3 on as one array, `null` (no width) where the table lists none. */
const denseFromThree = (length: number): string =>
  Array.from({ length }, (_, index) => ARIAL_WIDTHS.get(index + 3) ?? 'null').join(' ');

function stream(dictionary: string, bytes: Buffer): string {
  return `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
}

/** A page shown in the first of `fonts` Arial fonts that all name one /W object and one TrueType program, and the array object `array` that /W may name. */
function sharedWidthsPdf(fonts: number, array: string, widths: string): Buffer {
  const [file, w] = [extraObjectNumber(1), extraObjectNumber(1) + 2];
  const objects = [stream(`/Length1 ${BARE_TRUETYPE.length}`, BARE_TRUETYPE), array, `[${widths}]`];
  let resources = '';
  for (let font = 0; font < fonts; font++) {
    const type0 = w + 1 + font * 3;
    resources += `/F${font + 2} ${type0} 0 R `;
    objects.push(
      `<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /DescendantFonts [${type0 + 1} 0 R] >>`,
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Arial /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${type0 + 2} 0 R /DW 1000 /W ${w} 0 R >>`,
      `<< /Type /FontDescriptor /FontName /Arial /Flags 32 /FontBBox [-665 -325 2000 1006] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 716 /StemV 80 /FontFile2 ${file} 0 R >>`
    );
  }
  const shown = ARIAL_CIDS.map((cid) => cid.toString(16).padStart(4, '0')).join('');
  return rawPdf([{ width: 400, height: 200, content: `BT /F2 14 Tf 20 100 Td <${shown}> Tj ET`, fonts: resources }], objects);
}

/** The array object that `sharedWidthsPdf` writes right after the font program. */
const bigReference = (): string => `${extraObjectNumber(1) + 1} 0 R`;

function timed<T>(read: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = read();
  return { value, ms: performance.now() - started };
}

const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));

describe('a /W built to cost the pass much more than its size', () => {
  it('reads one 100,000-entry array named 1,000 times from far below the CIDs asked for, in 64 fonts, at the cost of the entries', { timeout: TIMEOUT_MS }, () => {
    const array = `[${'0 '.repeat(100_000)}]`;
    const pdf = sharedWidthsPdf(FONT_COUNT, array, `${listed(ARIAL_WIDTHS)} ${`${FAR_BELOW} ${bigReference()} `.repeat(1_000)}`);
    const { value, ms } = timed(() => readable(pdf));
    expect(value.length).toBeGreaterThan(pdf.length);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('leaves the fonts as they were when /W names a 1,000-entry array 100,000 times from the first CID, past the step budget, though every width is the font\'s', { timeout: TIMEOUT_MS }, () => {
    const pdf = sharedWidthsPdf(FONT_COUNT, `[${denseFromThree(1_000)}]`, `3 ${bigReference()} `.repeat(100_000));
    const { value, ms } = timed(() => readable(pdf));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(value).toBe(pdf);
  });

  it('reads the same widths when the array they come from is the one /W, however it is written', () => {
    const inline = sharedWidthsPdf(1, '[]', `3 [${denseFromThree(169)}]`);
    const named = sharedWidthsPdf(1, `[${denseFromThree(169)}]`, `3 ${bigReference()}`);
    expect(readable(inline).length).toBeGreaterThan(inline.length);
    expect(readable(named).length).toBeGreaterThan(named.length);
  });
});
