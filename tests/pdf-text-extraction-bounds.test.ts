import { describe, expect, it, vi } from 'vitest';
import { extractStructuredTextFromPdf, recursiveXyCut, type PdfTextBlock } from '../src/lib/conversions/pdf-utils';
import { PayloadLimitError } from '../src/lib/types';
import { type CraftObject, buildPdf, flate, singlePagePdf, textContent } from './helpers/pdf-craft';
import {
  expectNoHang,
  SCALING_FACTOR,
  SCALING_TEST_TIMEOUT_MS,
  settle,
  expectNoHangOnInput,
} from './helpers/timing';

/**
 * Text extraction costs time and memory proportional to the content stream, whatever the operators
 * look like, and a document may yield only a bounded number of text blocks. Operator semantics follow
 * ISO 32000-1 section 9.4 (text objects) and 9.3 (Tf), with every expected value written by hand.
 */

// Bounds are checked by comparing two inputs in the same process (tests/helpers/timing.ts), so the verdict does
// not depend on how fast the runner is: a linear reader takes about 4x as long for a 4x longer stream, a
// quadratic one 16x; work that must stop at a cap costs the same however far past the cap the input goes.
const BOUND_TEST_TIMEOUT_MS = 60_000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const OPERAND_RUN = 80 * 1000;
const BLOCKS_OVER_CAP = 100 * 1000 + 1;
const FORM_BLOCKS = 1000;
const FORM_INVOCATIONS = 120;
const XY_CUT_BLOCKS = 50 * 1000;

vi.setConfig({ testTimeout: BOUND_TEST_TIMEOUT_MS });

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

describe('operator scanning terminates on a long content stream (growth is measured by the perf suite)', () => {
  async function expectLinearExtraction(label: string, content: (run: number) => string) {
    const { largeResult } = await expectNoHangOnInput(
      label,
      (pdf: Buffer) => extractStructuredTextFromPdf(pdf),
      pageWith(content(OPERAND_RUN * SCALING_FACTOR))
    );
    return largeResult;
  }

  it('reads a long digit run without backtracking (Tm, Td)', async () => {
    const value = await expectLinearExtraction('digit run', (run) => `BT ${'1'.repeat(run)} ET`);
    expect(value.blocks).toEqual([]);
  });

  it('reads a long run of opening brackets without backtracking (TJ)', async () => {
    const value = await expectLinearExtraction('bracket run', (run) => `BT ${'['.repeat(run)} ET`);
    expect(value.blocks).toEqual([]);
  });

  it('reads a long run of unterminated strings and hex strings', async () => {
    const value = await expectLinearExtraction('string runs', (run) => `BT ${'('.repeat(run)} Tj ${'<'.repeat(run)} Tj ET`);
    expect(value.blocks).toEqual([]);
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
  it('refuses a content stream with more blocks than the cap (hang guard; growth ratio in the perf suite)', async () => {
    const { largeResult } = await expectNoHangOnInput(
      'blocks past the cap',
      (pdf: Buffer) => settle(() => extractStructuredTextFromPdf(pdf)),
      pageWith('BT (a) Tj ET\n'.repeat(BLOCKS_OVER_CAP))
    );
    if (largeResult.ok) throw new Error('a stream with more blocks than the cap was accepted');
    expect(largeResult.error).toBeInstanceOf(PayloadLimitError);
    expect((largeResult.error as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((largeResult.error as Error).message).toMatch(/text blocks/);
  });

  it('counts the blocks of a form XObject once per drawing, across the document (hang guard; growth ratio in the perf suite)', async () => {
    // 120 drawings of a 1000-block form pass the 100,000 cap; 480 drawings are refused after the same work,
    // because the count stops the extraction, not after drawing all of them.
    const drawings = (invocations: number): Buffer => {
      const form: CraftObject = {
        id: 6,
        dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >>',
        stream: Buffer.from('BT (x) Tj ET\n'.repeat(FORM_BLOCKS), 'latin1'),
      };
      return pageWith('/Fm0 Do\n'.repeat(invocations), [form], '<< /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>');
    };
    const { largeResult } = await expectNoHangOnInput(
      'form drawings',
      (pdf: Buffer) => settle(() => extractStructuredTextFromPdf(pdf)),
      drawings(FORM_INVOCATIONS * SCALING_FACTOR)
    );
    if (largeResult.ok) throw new Error('the form drawings were accepted');
    expect(largeResult.error).toBeInstanceOf(PayloadLimitError);
    expect((largeResult.error as Error).message).toMatch(/text blocks/);
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
    expect((err as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });

  it('keeps a page of ordinary size', () => {
    const lines = Array.from({ length: 50 }, (_, i) => textContent(`LINE-${i}`, 700 - i * 14)).join('');
    const { blocks } = extractStructuredTextFromPdf(pageWith(lines));
    expect(blocks.map((b) => b.text)).toEqual(Array.from({ length: 50 }, (_, i) => `LINE-${i}`));
  });
});

describe('reading-order cuts stay near-linear in the block count', () => {
  const gridOf = (count: number): PdfTextBlock[] =>
    Array.from({ length: count }, (_, i) => ({
      text: `b${i}`,
      x: (i % 200) * 50,
      y: Math.floor(i / 200) * 20,
      width: 40,
      height: 10,
    }));

  it('orders a grid of blocks top-down and left-to-right', () => {
    const blocks = 5000;
    const ordered = recursiveXyCut(gridOf(blocks));
    expect(ordered).toHaveLength(blocks);
    expect(ordered[0].text).toBe(`b${blocks - 200}`);
    expect(ordered[1].text).toBe(`b${blocks - 200 + 1}`);
  });

  it('orders a long column of blocks in near-linear time (hang guard; growth ratio in the perf suite)', async () => {
    // Each cut peels one row and the recursion stops cutting at MAX_XY_CUT_DEPTH, so once a column is longer than
    // that cap the cost is about n log n per level: 4x the rows costs 4x to 6.5x (measured), a quadratic cut 16x.
    // (Below the cap the depth grows with the input, which makes smaller grids look quadratic.)
    const column = (count: number): PdfTextBlock[] =>
      Array.from({ length: count }, (_, i) => ({ text: `r${i}`, x: 0, y: i * 20, width: 40, height: 10 }));
    const { largeResult: ordered } = await expectNoHangOnInput(
      'xy-cut column',
      (blocks: PdfTextBlock[]) => recursiveXyCut(blocks),
      column(XY_CUT_BLOCKS)
    );
    expect(ordered).toHaveLength(XY_CUT_BLOCKS);
    expect(ordered[0].text).toBe(`r${XY_CUT_BLOCKS - 1}`);
    expect(ordered[XY_CUT_BLOCKS - 1].text).toBe('r0');
  }, SCALING_TEST_TIMEOUT_MS);

  it('terminates on a staircase that peels one block per cut', async () => {
    const staircase: PdfTextBlock[] = Array.from({ length: 5000 }, (_, i) => ({
      text: `s${i}`,
      x: i * 100,
      y: i * 100,
      width: 10,
      height: 10,
    }));
    // Each cut peels one block, so the cost is inherently quadratic here; the check is that it terminates.
    const ordered = await expectNoHang('staircase', () => recursiveXyCut(staircase));
    expect(ordered).toHaveLength(staircase.length);
  });
});
