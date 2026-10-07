import { describe, expect, it, vi } from 'vitest';
import { extractStructuredTextFromPdf, parseToUnicodeCMap } from '../src/lib/conversions/pdf-utils';
import { PayloadLimitError } from '../src/lib/types';
import { type CraftObject, buildPdf, flate, textContent } from './helpers/pdf-craft';
import { expectLinearOnInputs, expectSizeIndependentOnInputs, SCALING_FACTOR, settle } from './helpers/timing';

/**
 * ToUnicode CMaps (ISO 32000-1 section 9.10.3, Adobe Technical Note 5014 for bfrange and bfchar)
 * declare ranges whose expansion the file controls, so a range and the whole map are capped, and
 * section markers are located without rescanning the stream. Expected values are written by hand.
 */

// Bounds are checked by comparing runs in the same process (tests/helpers/timing.ts): a refused range must cost
// the same whatever span it declares, and a marker scan must grow linearly with the input. Neither depends on
// how fast the runner is.
const BOUND_TEST_TIMEOUT_MS = 60_000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const RANGE_CAP = 0x10000;
const UNTERMINATED_MARKERS = 100 * 1000;
const OVERLAPPING_RANGES = 8;
const FONT_COUNT = 3;
const RANGES_PER_FONT = 3;

vi.setConfig({ testTimeout: BOUND_TEST_TIMEOUT_MS });

function timed<T>(run: () => T): { value?: T; err?: unknown; ms: number } {
  const started = Date.now();
  try {
    return { value: run(), ms: Date.now() - started };
  } catch (err) {
    return { err, ms: Date.now() - started };
  }
}

const wrap = (body: string): string => `/CIDInit /ProcSet findresource begin begincmap ${body} endcmap`;

describe('bfrange expansion is capped', () => {
  it('maps a range of exactly the cap, with consecutive destinations', () => {
    const cmap = parseToUnicodeCMap(wrap('1 beginbfrange <0000> <FFFF> <0041> endbfrange'));
    expect(cmap.charMap.size).toBe(RANGE_CAP);
    expect(cmap.charMap.get(0x1234)).toBe(String.fromCharCode(0x41 + 0x1234));
  });

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

  it('still reads bfchar, bfrange and cidchar sections', () => {
    const cmap = parseToUnicodeCMap(
      wrap(
        [
          '1 beginbfchar <0003> <0041> endbfchar',
          '1 beginbfrange <0010> <0012> <0061> endbfrange',
          '1 begincidchar <0020> 66 endcidchar',
        ].join('\n')
      )
    );
    expect([...cmap.charMap.entries()]).toEqual([
      [3, 'A'],
      [0x10, 'a'],
      [0x11, 'b'],
      [0x12, 'c'],
      [0x20, 'B'],
    ]);
  });
});

describe('CMaps of one document share a mapping budget', () => {
  function pdfWithEvilCMaps(fonts: number, rangesPerFont: number): Buffer {
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>' },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate(textContent('x')) },
    ];
    for (let f = 0; f < fonts; f++) {
      const ranges = Array.from(
        { length: rangesPerFont },
        (_, r) => `<${(f * 16 + r + 1).toString(16).padStart(4, '0')}0000> <${(f * 16 + r + 1).toString(16).padStart(4, '0')}FFFF> <0041>`
      ).join('\n');
      objects.push({ id: 5 + f, raw: `<< /Type /Font /Subtype /Type0 /BaseFont /F${f} /ToUnicode ${20 + f} 0 R >>` });
      objects.push({
        id: 20 + f,
        dict: '/Filter /FlateDecode',
        stream: flate(wrap(`${rangesPerFont} beginbfrange ${ranges} endbfrange`)),
      });
    }
    return buildPdf(objects, 1).buffer;
  }

  it('reads a document whose CMaps stay inside the budget', () => {
    const { value } = timed(() => extractStructuredTextFromPdf(pdfWithEvilCMaps(1, RANGES_PER_FONT)));
    expect(value?.cmaps.size).toBe(1);
    expect([...(value?.cmaps.values() ?? [])][0].charMap.size).toBe(RANGES_PER_FONT * RANGE_CAP);
  });

  it('refuses a document whose CMaps together map more than the budget', () => {
    const { err } = timed(() => extractStructuredTextFromPdf(pdfWithEvilCMaps(FONT_COUNT * 2, RANGES_PER_FONT)));
    expect(err).toBeInstanceOf(PayloadLimitError);
    expect((err as Error).message).toMatch(/character mappings/);
  });

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
  });
});
