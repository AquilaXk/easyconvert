import { describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { graphicsStateDepth } from '../src/lib/conversions/pdf-stream-guard';
import { layoutPdfDocument } from '../src/lib/conversions/pdf-layout';
import type { PdfContentFont, PdfContentItem, PdfPageContent } from '../src/lib/conversions/pdf-text-types';
import { type CraftObject, buildPdf, flate, singlePagePdf } from './helpers/pdf-craft';
import { expectLinearOnInputs, expectSizeIndependentOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks for the hostile inputs of pdf-text-hostile-input.test.ts and pdf-layout-units.test.ts, which keep
 * a hang guard on the same inputs in the PR gate. They compare runs of the same work and need a quiet machine, so they
 * run in the nightly performance workflow (`npx vitest run --no-file-parallelism .perf.test.ts`).
 */

const BOUND_TEST_TIMEOUT_MS = 120_000;
const OPERAND_RUN = 80 * 1000;
const COLUMN_LINES = 50 * 1000;
/** n log n with allocation: a quadratic layout takes 16x for 4x the lines. */
const COLUMN_MAX_RATIO = 10;
const STATE_DEPTH_LIMIT = 256;
const NESTING_MODEST = 512;
const NESTING_HUGE = 100 * 1000;
const RANGE_MODEST = '0000FFFF';
const RANGE_HUGE = '0FFFFFFF';
const CONTENT_STREAM_BYTES = 8 * 1024 * 1024;

vi.setConfig({ testTimeout: BOUND_TEST_TIMEOUT_MS });

const pageWith = (content: string): Buffer => singlePagePdf(flate(content), [], {}).buffer;
const textOf = async (pdf: Buffer): Promise<string> => (await convertFile(pdf, 'pdf', 'txt', {}, 'hostile.pdf')).buffer.toString('utf8');

describe('operator scanning is linear in the content stream', () => {
  for (const [label, content] of [
    ['a digit run', (run: number) => `BT ${'1'.repeat(run)} ET`],
    ['a run of opening brackets', (run: number) => `BT ${'['.repeat(run)} ET`],
    ['unterminated strings and hex strings', (run: number) => `BT ${'('.repeat(run)} Tj ${'<'.repeat(run)} Tj ET`],
  ] as const) {
    it(`reads ${label} in time linear in its length`, async () => {
      const { largeResult } = await expectLinearOnInputs(label, textOf, {
        small: pageWith(content(OPERAND_RUN)),
        large: pageWith(content(OPERAND_RUN * SCALING_FACTOR)),
      });
      expect(largeResult).toBe('');
    });
  }
});

describe('graphics-state nesting', () => {
  it('is refused after the same work however deep the stream nests', async () => {
    const { largeResult } = await expectSizeIndependentOnInputs('q nesting', (content: string) => graphicsStateDepth(content, STATE_DEPTH_LIMIT), {
      modest: 'q '.repeat(NESTING_MODEST),
      huge: 'q '.repeat(NESTING_HUGE),
    });
    expect(largeResult).toBe(STATE_DEPTH_LIMIT + 1);
  });

  it('is counted in time linear in the stream length', async () => {
    const stream = (bytes: number): string => 'q Q BT (text) Tj ET\n'.repeat(Math.floor(bytes / 20));
    const { largeResult } = await expectLinearOnInputs('q scan', (content: string) => graphicsStateDepth(content), {
      small: stream(CONTENT_STREAM_BYTES / SCALING_FACTOR),
      large: stream(CONTENT_STREAM_BYTES),
    });
    expect(largeResult).toBe(1);
  });
});

describe('ToUnicode ranges are refused or skipped after the same work however wide they are', () => {
  function pdfWithRange(last: string): Buffer {
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>' },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate('BT /F1 12 Tf 10 700 Td <0001> Tj ET') },
      { id: 5, raw: '<< /Type /Font /Subtype /Type0 /BaseFont /Evil /Encoding /Identity-H /ToUnicode 6 0 R >>' },
      {
        id: 6,
        dict: '/Filter /FlateDecode',
        stream: flate(`/CIDInit /ProcSet findresource begin begincmap 1 beginbfrange <00000000> <${last}> <0041> endbfrange endcmap`),
      },
    ];
    return buildPdf(objects, 1).buffer;
  }

  it('reads a range of 65,536 and one of 268 million alike', async () => {
    await expectSizeIndependentOnInputs('bfrange width', textOf, { modest: pdfWithRange(RANGE_MODEST), huge: pdfWithRange(RANGE_HUGE) });
  });
});

describe('reading-order layout stays near-linear in the line count', () => {
  const font: PdfContentFont = { name: 'Body', bold: false, italic: false, monospace: false, serif: false };
  const column = (count: number): PdfPageContent => {
    const items: PdfContentItem[] = Array.from({ length: count }, (_, i) => ({
      text: `r${i}`,
      x: 20,
      baseline: 20 + i * 20,
      width: 12,
      size: 12,
      font: 0,
      rtl: false,
      angled: false,
      vertical: false,
    }));
    return { pageNumber: 1, width: 600, height: 800, items, rules: [], images: [], unmappedItems: 0, operatorsSkipped: false, rulesTruncated: false };
  };

  it('lays out a long column of lines in near-linear time', async () => {
    const { largeResult } = await expectLinearOnInputs('column of lines', (page: PdfPageContent) => layoutPdfDocument([page], [font]), {
      small: column(COLUMN_LINES / SCALING_FACTOR),
      large: column(COLUMN_LINES),
      maxRatio: COLUMN_MAX_RATIO,
    });
    expect(largeResult.pageCount).toBe(1);
  }, SCALING_TEST_TIMEOUT_MS);
});
