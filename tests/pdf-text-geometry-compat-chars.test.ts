import { describe, expect, it } from 'vitest';
import { extractPdfTextLayerPages } from '../src/lib/conversions/pdf-text-geometry';
import { oracleTest } from './helpers/oracle-test';
import { matchedIou, ocrWords, popplerWords } from './helpers/poppler-words';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';

/**
 * Characters whose compatibility form differs from the character itself (superscript digits, trade mark,
 * ellipsis, fractions, the micro sign and ligatures) must not stop the glyph advances from being matched to
 * the item text: when they do, every word of the item gets an equal share of its width and the boxes are off
 * by many characters. `pdftotext -bbox-layout` is the oracle for the boxes.
 */

const STRICT_IOU = 0.9;
const TEST_TIMEOUT_MS = 120_000;
const WIN_ANSI_SUPERSCRIPT_TWO = String.fromCodePoint(0xb2);
const WIN_ANSI_TRADE_MARK = String.fromCodePoint(0x99);
const WIN_ANSI_ELLIPSIS = String.fromCodePoint(0x85);
const WIN_ANSI_ONE_HALF = String.fromCodePoint(0xbd);
const WIN_ANSI_MICRO = String.fromCodePoint(0xb5);
/** Codes 1 and 2 of the second font are the ligature glyphs fi and fl. */
const LIGATURE_FI = '\\001';
const LIGATURE_FL = '\\002';
const LINE_STEP_PT = 24;
const FIRST_BASELINE_PT = 180;

/** Helvetica with the WinAnsi encoding plus the glyphs fi and fl at codes 1 and 2. */
const LIGATURE_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [ 1 /fi /fl ] >> >>';

function lineOf(text: string, index: number): string {
  const y = FIRST_BASELINE_PT - index * LINE_STEP_PT;
  return `BT /F2 12 Tf 1 0 0 1 20 ${y} Tm (${text}) Tj ET\n`;
}

/** One line per character class; the narrow letters before it make an equal split of the item's width wrong. */
function compatibilityPdf(): Buffer {
  const lines = [
    `iiiiiiii${WIN_ANSI_SUPERSCRIPT_TWO}iiii WWWWWW`,
    `iiiiiiii${WIN_ANSI_TRADE_MARK}iiii WWWWWW`,
    `iiiiiiii${WIN_ANSI_ELLIPSIS}iiii WWWWWW`,
    `iiiiiiii${WIN_ANSI_ONE_HALF}iiii WWWWWW`,
    `iiiiiiii${WIN_ANSI_MICRO}iiii WWWWWW`,
    `${LIGATURE_FI}nal o${LIGATURE_FL}ce iiiiii WWWWWW`,
  ];
  return rawPdf(
    [
      {
        width: 300,
        height: 200,
        content: lines.map(lineOf).join(''),
        fonts: `/F2 ${extraObjectNumber(1)} 0 R`,
      },
    ],
    [LIGATURE_FONT]
  );
}

describe('compatibility characters in text items', () => {
  oracleTest(
    'word boxes after a superscript digit, trade mark, ellipsis, fraction, micro sign or ligature overlap the reference at 0.9 or better',
    ['pdftotext'],
    async () => {
      const pdf = compatibilityPdf();
      const reference = popplerWords(pdf);
      const mine = ocrWords(await extractPdfTextLayerPages(pdf, new Set([1])));
      expect(reference).toHaveLength(14);
      expect(mine).toHaveLength(reference.length);
      const ious = matchedIou(reference, mine);
      reference.forEach((word, index) => {
        expect(ious[index], `'${word.text}'`).toBeGreaterThanOrEqual(STRICT_IOU);
      });
    },
    TEST_TIMEOUT_MS
  );

  it('splits a word that follows a superscript digit by the glyph advances, not by equal shares', async () => {
    const pdf = compatibilityPdf();
    const words = ocrWords(await extractPdfTextLayerPages(pdf, new Set([1])));
    const first = words.find((word) => word.text.startsWith('iiiiiiii'));
    const wide = words.find((word) => word.text === 'WWWWWW');
    expect(first).toBeDefined();
    expect(wide).toBeDefined();
    // Eight narrow letters in Helvetica are 8 x 222 units and the six capitals 6 x 944: with equal shares the
    // narrow word would be as wide per letter as the capitals.
    const narrowPerLetter = ((first?.x1 ?? 0) - (first?.x0 ?? 0)) / (first?.text.length ?? 1);
    const widePerLetter = ((wide?.x1 ?? 0) - (wide?.x0 ?? 0)) / (wide?.text.length ?? 1);
    expect(narrowPerLetter).toBeLessThan(widePerLetter / 2);
  });
});
