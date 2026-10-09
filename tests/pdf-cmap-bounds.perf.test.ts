import { describe, expect, it, vi } from 'vitest';
import { extractStructuredTextFromPdf, parseToUnicodeCMap } from '../src/lib/conversions/pdf-utils';
import { PayloadLimitError } from '../src/lib/types';
import { type CraftObject, buildPdf, flate, textContent } from './helpers/pdf-craft';
import { expectLinearOnInputs, expectSizeIndependentOnInputs, SCALING_FACTOR, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of pdf-cmap-bounds.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in pdf-cmap-bounds.test.ts.
 */

// Bounds are checked by comparing runs in the same process (tests/helpers/timing.ts): a refused range must cost
// the same whatever span it declares, and a marker scan must grow linearly with the input. Neither depends on
// how fast the runner is.
const BOUND_TEST_TIMEOUT_MS = 60_000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const UNTERMINATED_MARKERS = 100 * 1000;
const OVERLAPPING_RANGES = 8;

const wrap = (body: string): string => `/CIDInit /ProcSet findresource begin begincmap ${body} endcmap`;

vi.setConfig({ testTimeout: BOUND_TEST_TIMEOUT_MS });

describe('bfrange expansion is capped', () => {
  it('refuses a range past the cap without expanding it', async () => {
    // A range one past the cap and one 256 times as wide are refused after the same work: nothing is expanded.
    const range = (last: string) => wrap(`1 beginbfrange <00000000> <${last}> <0041> endbfrange`);
    const { largeResult } = await expectSizeIndependentOnInputs('range past the cap', (cmap: string) => settle(() => parseToUnicodeCMap(cmap)), {
      modest: range('00010000'),
      huge: range('00FFFFFF'),
    });
    if (largeResult.ok) throw new Error('the oversized range was accepted');
    expect(largeResult.error).toBeInstanceOf(PayloadLimitError);
    expect((largeResult.error as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((largeResult.error as Error).message).toMatch(/range/);
  });

  it('refuses ranges whose combined expansion passes the map cap, even when they overlap', async () => {
    // Eight ranges of 65,536 overlap in one block; the cap is passed within them, so 32 such ranges are
    // refused after about the same work, not after reading all of them.
    const overlapping = (count: number) => wrap(`${count} beginbfrange ${'<00010000> <0001FFFF> <0041>\n'.repeat(count)} endbfrange`);
    const { largeResult } = await expectSizeIndependentOnInputs('overlapping ranges', (cmap: string) => settle(() => parseToUnicodeCMap(cmap)), {
      modest: overlapping(OVERLAPPING_RANGES),
      huge: overlapping(OVERLAPPING_RANGES * SCALING_FACTOR),
    });
    if (largeResult.ok) throw new Error('the overlapping ranges were accepted');
    expect(largeResult.error).toBeInstanceOf(PayloadLimitError);
    expect((largeResult.error as Error).message).toMatch(/character mappings/);
  });

  it('reads an array range by its elements, not by its declared span', async () => {
    const arrayRange = (last: string) => wrap(`1 beginbfrange <00000000> <${last}> [<0041> <0042>] endbfrange`);
    const { largeResult } = await expectSizeIndependentOnInputs('array range', (cmap: string) => parseToUnicodeCMap(cmap), {
      modest: arrayRange('0000FFFF'),
      huge: arrayRange('FFFFFFFF'),
    });
    expect([...largeResult.charMap.entries()]).toEqual([
      [0, 'A'],
      [1, 'B'],
    ]);
  });
});

describe('section markers are found in linear time', () => {
  for (const begin of ['beginbfchar', 'beginbfrange', 'begincidchar']) {
    it(`reads many unterminated ${begin} markers in one pass`, async () => {
      const { largeResult } = await expectLinearOnInputs(begin, (cmap: string) => parseToUnicodeCMap(cmap), {
        small: `${begin} `.repeat(UNTERMINATED_MARKERS),
        large: `${begin} `.repeat(UNTERMINATED_MARKERS * SCALING_FACTOR),
      });
      expect(largeResult.charMap.size).toBe(0);
    });
  }

  it('reads many unterminated array ranges in one pass', async () => {
    const arrays = (count: number) => `beginbfrange ${'<0001> <0002> [ '.repeat(count)}endbfrange`;
    const { largeResult } = await expectLinearOnInputs('array ranges', (cmap: string) => parseToUnicodeCMap(cmap), {
      small: arrays(UNTERMINATED_MARKERS),
      large: arrays(UNTERMINATED_MARKERS * SCALING_FACTOR),
    });
    expect(largeResult.charMap.size).toBe(0);
  });
});

describe('CMaps of one document share a mapping budget', () => {
  it('refuses a ToUnicode stream that declares a huge range', async () => {
    const pdfWithRange = (last: string): Buffer => {
      const objects: CraftObject[] = [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>' },
        { id: 4, dict: '/Filter /FlateDecode', stream: flate(textContent('x')) },
        { id: 5, raw: '<< /Type /Font /Subtype /Type0 /BaseFont /Evil /ToUnicode 6 0 R >>' },
        {
          id: 6,
          dict: '/Filter /FlateDecode',
          stream: flate(wrap(`1 beginbfrange <00000000> <${last}> <0041> endbfrange`)),
        },
      ];
      return buildPdf(objects, 1).buffer;
    };
    const { largeResult } = await expectSizeIndependentOnInputs('range declared in a PDF', (pdf: Buffer) => settle(() => extractStructuredTextFromPdf(pdf)), {
      modest: pdfWithRange('00010000'),
      huge: pdfWithRange('0FFFFFFF'),
    });
    if (largeResult.ok) throw new Error('the huge range was accepted');
    expect(largeResult.error).toBeInstanceOf(PayloadLimitError);
    expect((largeResult.error as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((largeResult.error as Error).message).toMatch(/range/);
  });
});
