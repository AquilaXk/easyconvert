import { describe, expect, it } from 'vitest';
import { placeItem, type Cursor, type Glyph } from '../src/lib/conversions/pdf-text-geometry';

/**
 * Visual order of text that mixes left-to-right letters, right-to-left letters and numbers, including the
 * Arabic-Indic digits (bidirectional class AN) and the extended ones (EN). The expected visual strings are
 * the output of a separate implementation of Unicode Annex 9 (python-bidi 0.6.11, `get_display` with the
 * paragraph direction given), recorded here as a golden table of [logical text, direction, visual text].
 *
 * The page's glyphs are in visual order, so an item matches its glyph stream only when the order computed
 * for it equals the expected visual string; each glyph gets a distinct advance, so a match is visible in
 * the placement and a mismatch (equal shares, or a thrown error for mixed text) is not.
 */

const FIRST_ADVANCE = 1;

const GOLDEN: Array<[string, 'ltr' | 'rtl', string]> = [
  ['ab ١٢٣ ד', 'ltr', 'ab ד ١٢٣'],
  ['ab ١٢٣ שלום', 'ltr', 'ab םולש ١٢٣'],
  ['ab ١٢٣ שלום', 'rtl', 'םולש ١٢٣ ab'],
  ['שלום ١٢٣ ab', 'rtl', 'ab ١٢٣ םולש'],
  ['שלום ١٢٣ ab', 'ltr', '١٢٣ םולש ab'],
  ['عربي ١٢٣', 'rtl', '١٢٣ يبرع'],
  ['عربي ١٢٣', 'ltr', '١٢٣ يبرع'],
  ['عربي 123', 'rtl', '123 يبرع'],
  ['عربي 123 ab', 'ltr', '123 يبرع ab'],
  ['ab عربي 123', 'ltr', 'ab 123 يبرع'],
  ['שלום 123', 'rtl', '123 םולש'],
  ['שלום 123 ab', 'ltr', '123 םולש ab'],
  ['ab שלום 123', 'ltr', 'ab 123 םולש'],
  ['عربي ١٢,٣٤٥ שלום', 'rtl', 'םולש ١٢,٣٤٥ يبرع'],
  ['عربي ١٢.٣٤٥ ab', 'ltr', '١٢.٣٤٥ يبرع ab'],
  ['عربي 12,345 שלום', 'rtl', 'םולש 12,345 يبرع'],
  ['שלום ۱۲۳ ab', 'ltr', '۱۲۳ םולש ab'],
  ['ab ۱۲۳ שלום', 'ltr', 'ab ۱۲۳ םולש'],
  ['عربي $١٢', 'rtl', '١٢$ يبرع'],
  ['عربي ١٢%', 'rtl', '%١٢ يبرع'],
  ['שלום $12', 'rtl', '$12 םולש'],
  ['שלום 12% ab', 'ltr', '12% םולש ab'],
  ['ab שלום - 5 עולם', 'ltr', 'ab םלוע 5 - םולש'],
  ['שלום עולם ١٢٣', 'rtl', '١٢٣ םלוע םולש'],
  ['שלום עולם ١٢٣ ab', 'ltr', '١٢٣ םלוע םולש ab'],
  ['عربي مرحبا ۱۲۳', 'rtl', '۱۲۳ ابحرم يبرع'],
  ['x ١ שלום', 'ltr', 'x םולש ١'],
  ['١٢٣ שלום', 'ltr', 'םולש ١٢٣'],
  ['١٢٣ שלום', 'rtl', 'םולש ١٢٣'],
  ['12 عربي ١٢', 'ltr', '12 ١٢ يبرع'],
];

function glyphsOf(visual: string): Glyph[] {
  return [...visual].map((character, index) => ({
    text: character,
    folded: character.normalize('NFKC'),
    advance: FIRST_ADVANCE + index,
    cross: 1,
    em: 1,
    adjustment: 1,
  }));
}

describe('visual order of numbers in right-to-left text', () => {
  it.each(GOLDEN)('%s (%s) is drawn as %s', (logical, direction, visual) => {
    const cursor: Cursor = { glyphs: glyphsOf(visual), next: 0, failures: 0, steps: 0 };
    const placement = placeItem({ str: logical, dir: direction }, cursor, false, 1);
    const expected = [...visual].map((_, index) => FIRST_ADVANCE + index);
    expect(placement.advance).toEqual(expected);
    expect(cursor.next).toBe([...visual].length);
  });

  it('does not match a glyph stream in the logical order of Arabic-Indic digits', () => {
    // The digits of a number keep their order; reversing them as if they were letters is wrong.
    const cursor: Cursor = { glyphs: glyphsOf('ab ד \u0663\u0662\u0661'), next: 0, failures: 0, steps: 0 };
    expect(() => placeItem({ str: 'ab \u0661\u0662\u0663 \u05d3', dir: 'ltr' }, cursor, false, 1)).toThrow(/cannot be resolved/);
  });
});
