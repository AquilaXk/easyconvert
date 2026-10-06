import { describe, expect, it } from 'vitest';
import {
  analyzePdfPagesInProcess,
  PDF_TEXT_MAX_CHARS_PER_PAGE,
  PDF_TEXT_MAX_ITEM_CHARS,
  PdfTextGeometryError,
  placeItem,
  type Cursor,
  type Glyph,
} from '../src/lib/conversions/pdf-text-geometry';
import { rawPdf, run } from './helpers/raw-pdf';

/**
 * Work done to match an item's text to the page's glyph stream is bounded by the item's length, and the
 * characters a page may hold are capped, so a hostile page cannot turn the resync search into minutes of CPU.
 */

const TEST_TIMEOUT_MS = 120_000;
const ITEM_CHARS = 200_000;
/** Steps the matching of one item may take, per character of the item; the first attempt alone needs one. */
const STEP_BUDGET_PER_CHAR = 16;
const WIDE_PAGE_PT = 2_000_000;
const LONG_ITEM_CHARS = 1_000_000;
const SUPERSCRIPT_TWO = '²';

function glyphOf(text: string): Glyph {
  return { text, folded: text.normalize('NFKC'), advance: 1, cross: 1, em: 1, adjustment: 1 };
}

describe('glyph matching work', () => {
  it('stops searching for a resync point after a few multiples of the item length', () => {
    // Every shifted start matches nearly to the end and then fails on the last character.
    const text = `${'a'.repeat(ITEM_CHARS - 1)}${SUPERSCRIPT_TWO}`;
    const glyphs: Glyph[] = Array.from({ length: ITEM_CHARS + 300 }, () => glyphOf('a'));
    const cursor: Cursor = { glyphs, next: 0, failures: 0, steps: 0 };
    const placement = placeItem({ str: text, dir: 'ltr' }, cursor, false, 1);
    expect(placement.advance).toHaveLength(ITEM_CHARS);
    expect(placement.advance.every((share) => share === 1)).toBe(true);
    expect(cursor.steps).toBeGreaterThan(ITEM_CHARS - 1);
    expect(cursor.steps).toBeLessThanOrEqual(STEP_BUDGET_PER_CHAR * ITEM_CHARS);
  });

  it('matches a long item in one pass over its glyphs', () => {
    const glyphs: Glyph[] = Array.from({ length: ITEM_CHARS }, () => glyphOf('a'));
    const cursor: Cursor = { glyphs, next: 0, failures: 0, steps: 0 };
    const placement = placeItem({ str: 'a'.repeat(ITEM_CHARS), dir: 'ltr' }, cursor, false, 1);
    expect(placement.advance).toHaveLength(ITEM_CHARS);
    expect(cursor.next).toBe(ITEM_CHARS);
    expect(cursor.steps).toBeLessThanOrEqual(2 * ITEM_CHARS);
  });
});

describe('characters per page', () => {
  it(
    `refuses a page that holds more than ${PDF_TEXT_MAX_CHARS_PER_PAGE} characters of text`,
    async () => {
      expect(LONG_ITEM_CHARS).toBeLessThanOrEqual(PDF_TEXT_MAX_ITEM_CHARS);
      const itemsNeeded = Math.floor(PDF_TEXT_MAX_CHARS_PER_PAGE / LONG_ITEM_CHARS) + 1;
      const content = Array.from({ length: itemsNeeded }, (_, index) => run('a'.repeat(LONG_ITEM_CHARS), 1, 20 + index * 20, 1)).join('');
      const pdf = rawPdf([{ width: WIDE_PAGE_PT, height: 20 + itemsNeeded * 20, content }]);
      const err = await analyzePdfPagesInProcess(pdf, { geometry: [1] }).then(
        () => null,
        (error: unknown) => error
      );
      expect(err).toBeInstanceOf(PdfTextGeometryError);
      expect((err as Error).message).toBe(`PDF page 1 has more than ${PDF_TEXT_MAX_CHARS_PER_PAGE} characters of text.`);
    },
    TEST_TIMEOUT_MS
  );
});
