import { describe, expect, it } from 'vitest';
import { extractStructuredTextFromPdf, recursiveXyCut, type PdfTextBlock } from '../src/lib/conversions/pdf-utils';
import { PayloadLimitError } from '../src/lib/types';
import { type CraftObject, buildPdf, flate, singlePagePdf, textContent } from './helpers/pdf-craft';

/**
 * Text extraction costs time and memory proportional to the content stream, whatever the operators
 * look like, and a document may yield only a bounded number of text blocks. Operator semantics follow
 * ISO 32000-1 section 9.4 (text objects) and 9.3 (Tf), with every expected value written by hand.
 */

const FAST_MS = 1000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const OPERAND_RUN = 80 * 1000;
const BLOCKS_OVER_CAP = 100 * 1000 + 1;
const FORM_BLOCKS = 1000;
const FORM_INVOCATIONS = 120;
const XY_CUT_BLOCKS = 50 * 1000;
const XY_CUT_MS = 2000;

function timed<T>(run: () => T): { value?: T; err?: unknown; ms: number } {
  const started = Date.now();
  try {
    return { value: run(), ms: Date.now() - started };
  } catch (err) {
    return { err, ms: Date.now() - started };
  }
}

function pageWith(content: string, extra: CraftObject[] = [], resources?: string): Buffer {
  return singlePagePdf(flate(content), extra, resources ? { resources } : {}).buffer;
}

describe('operator scanning is linear in the content stream', () => {
  it('reads a long digit run without backtracking (Tm, Td)', () => {
    const { value, ms } = timed(() => extractStructuredTextFromPdf(pageWith(`BT ${'1'.repeat(OPERAND_RUN)} ET`)));
    expect(value?.blocks).toEqual([]);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads a long run of opening brackets without backtracking (TJ)', () => {
    const { value, ms } = timed(() => extractStructuredTextFromPdf(pageWith(`BT ${'['.repeat(OPERAND_RUN)} ET`)));
    expect(value?.blocks).toEqual([]);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads a long run of unterminated strings and hex strings', () => {
    const { value, ms } = timed(() =>
      extractStructuredTextFromPdf(pageWith(`BT ${'('.repeat(OPERAND_RUN)} Tj ${'<'.repeat(OPERAND_RUN)} Tj ET`))
    );
    expect(value?.blocks).toEqual([]);
    expect(ms).toBeLessThan(FAST_MS);
  });
});

describe('text operators place and decode text as the specification defines', () => {
  const content = [
    'BT',
    '/F1 18 Tf',
    '1 0 0 1 100 200 Tm',
    '10 -5 Td',
    '[(Hel) -120 (lo) <20> (W\\157rld)] TJ',
    '(plain \\(escaped\\) and (balanced) parens) Tj',
    '<48656C6C6F> Tj',
    "(quoted line) '",
    'ET',
  ].join('\n');

  it('emits TJ arrays, then Tj strings, then quote strings, at the Tm plus Td position', () => {
    const { blocks } = extractStructuredTextFromPdf(pageWith(content));
    const placed = blocks.map((b) => ({ text: b.text, x: b.x, y: b.y, size: b.fontSize, font: b.fontName }));
    expect(placed).toEqual(
      expect.arrayContaining([
        { text: 'Hello World', x: 110, y: 195, size: 18, font: 'F1' },
        { text: 'plain (escaped) and (balanced) parens', x: 110, y: 195, size: 18, font: 'F1' },
        { text: 'Hello', x: 110, y: 195, size: 18, font: 'F1' },
        { text: 'quoted line', x: 110, y: 195, size: 18, font: 'F1' },
      ])
    );
    expect(blocks).toHaveLength(4);
  });

  it('decodes an operand that follows a comment and spans lines', () => {
    const { text } = extractStructuredTextFromPdf(pageWith('BT\n/F1 12 Tf % (hidden) Tj\n[(A)\n(B)] TJ\nET'));
    expect(text).toBe('AB');
  });
});

describe('a document yields a bounded number of text blocks', () => {
  it('refuses a content stream with more blocks than the cap', () => {
    const pdf = pageWith('BT (a) Tj ET\n'.repeat(BLOCKS_OVER_CAP));
    const { err, ms } = timed(() => extractStructuredTextFromPdf(pdf));
    expect(err).toBeInstanceOf(PayloadLimitError);
    expect((err as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((err as Error).message).toMatch(/text blocks/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('counts the blocks of a form XObject once per drawing, across the document', () => {
    const form: CraftObject = {
      id: 6,
      dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >>',
      stream: Buffer.from('BT (x) Tj ET\n'.repeat(FORM_BLOCKS), 'latin1'),
    };
    const pdf = pageWith('/Fm0 Do\n'.repeat(FORM_INVOCATIONS), [form], '<< /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>');
    const { err, ms } = timed(() => extractStructuredTextFromPdf(pdf));
    expect(err).toBeInstanceOf(PayloadLimitError);
    expect((err as Error).message).toMatch(/text blocks/);
    expect(ms).toBeLessThan(FAST_MS * 3);
  });

  it('counts the blocks of all pages together', () => {
    const pageCount = 20;
    const perPage = 6000;
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      {
        id: 2,
        dict: `/Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${10 + i} 0 R`).join(' ')}]`,
      },
    ];
    for (let i = 0; i < pageCount; i++) {
      objects.push({ id: 10 + i, dict: `/Type /Page /Parent 2 0 R /Contents ${100 + i} 0 R` });
      objects.push({ id: 100 + i, dict: '/Filter /FlateDecode', stream: flate('BT (a) Tj ET\n'.repeat(perPage)) });
    }
    const err = timed(() => extractStructuredTextFromPdf(buildPdf(objects, 1).buffer)).err;
    expect(err).toBeInstanceOf(PayloadLimitError);
  });

  it('keeps a page of ordinary size', () => {
    const lines = Array.from({ length: 50 }, (_, i) => textContent(`LINE-${i}`, 700 - i * 14)).join('');
    const { blocks } = extractStructuredTextFromPdf(pageWith(lines));
    expect(blocks.map((b) => b.text)).toEqual(Array.from({ length: 50 }, (_, i) => `LINE-${i}`));
  });
});

describe('reading-order cuts stay near-linear in the block count', () => {
  const grid: PdfTextBlock[] = Array.from({ length: XY_CUT_BLOCKS }, (_, i) => ({
    text: `b${i}`,
    x: (i % 200) * 50,
    y: Math.floor(i / 200) * 20,
    width: 40,
    height: 10,
  }));

  it('orders a grid of blocks quickly and top-down, left-to-right', () => {
    const { value, ms } = timed(() => recursiveXyCut(grid));
    expect(ms).toBeLessThan(XY_CUT_MS);
    const ordered = value as PdfTextBlock[];
    expect(ordered).toHaveLength(XY_CUT_BLOCKS);
    expect(ordered[0].text).toBe(`b${XY_CUT_BLOCKS - 200}`);
    expect(ordered[1].text).toBe(`b${XY_CUT_BLOCKS - 200 + 1}`);
  });

  it('terminates on a staircase that peels one block per cut', () => {
    const staircase: PdfTextBlock[] = Array.from({ length: 5000 }, (_, i) => ({
      text: `s${i}`,
      x: i * 100,
      y: i * 100,
      width: 10,
      height: 10,
    }));
    const { value, err, ms } = timed(() => recursiveXyCut(staircase));
    expect(err).toBeUndefined();
    expect(value).toHaveLength(staircase.length);
    expect(ms).toBeLessThan(XY_CUT_MS);
  });
});
