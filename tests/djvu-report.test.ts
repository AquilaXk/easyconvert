import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_INPUT_PIXELS } from '../src/lib/conversions/image-input-limits';
import { DJVU_MAX_PAGES } from '../src/lib/conversions/djvu-container';
import { parseDjvusedDirectory, parseDjvusedSizes } from '../src/lib/conversions/djvu-report';
import { expectWithinHangGuard } from './helpers/timing';

/**
 * The strict reading of what `djvused` prints (src/lib/conversions/djvu-report.ts): `n;ls` first, `size` once the include graph is
 * known. The text is what djvulibre 3.5.28 prints for `wc-dogv-12042005.djvu` (the first lines) and for the documents of
 * tests/djvu-render.test.ts; the programs themselves are run on real and built documents there.
 */

const PAGE_SIZE_LINE = 'width=4958 height=7017';
/** A line of a million markers is read in about 20 ms on a fast core; the guard catches a read that grows with the square of the line. */
const LONG_LINE_MARKERS = 1_000_000;
const LONG_LINE_EXPECTED_LOCAL_MS = 50;
const HANG_GUARD_MS = 10_000;

function lines(rows: readonly string[]): string {
  return `${rows.join('\n')}\n`;
}

const dogvDirectory = (pages: number) =>
  lines([
    String(pages),
    '     I     9248  dict0020.iff',
    ...Array.from({ length: pages }, (_, index) => `${String(index + 1).padStart(4)} P ${String(15895).padStart(8)}  p${String(index + 1).padStart(4, '0')}.djvu`),
  ]);

describe('the directory of a document', () => {
  it('reads the pages and the files of the DOGV document', () => {
    const { pageCount, entries } = parseDjvusedDirectory(dogvDirectory(3));
    expect(pageCount).toBe(3);
    expect(entries.map((entry) => [entry.page, entry.ids[0]])).toEqual([
      [false, 'dict0020.iff'],
      [true, 'p0001.djvu'],
      [true, 'p0002.djvu'],
      [true, 'p0003.djvu'],
    ]);
  });

  it('keeps the name and the title that follow the id', () => {
    const { entries } = parseDjvusedDirectory(lines(['1', '   1 P      140  p.iw4 F=cover.iw4 T=The cover']));
    expect(entries).toEqual([{ page: true, ids: ['p.iw4', 'p.iw4 F=cover.iw4 T=The cover'], names: ['cover.iw4'], titles: ['The cover'] }]);
  });

  it('reads a name of a million markers in one pass', () => {
    const name = ' F='.repeat(LONG_LINE_MARKERS) + ' T='.repeat(LONG_LINE_MARKERS);
    const started = process.hrtime.bigint();
    const { entries } = parseDjvusedDirectory(lines(['1', `   1 P      140  p.djvu${name}`]));
    expectWithinHangGuard('the directory line', Number(process.hrtime.bigint() - started) / 1e6, { guardMs: HANG_GUARD_MS, expectedLocalMs: LONG_LINE_EXPECTED_LOCAL_MS });
    expect(entries[0].ids[0]).toBe('p.djvu');
    expect(entries[0].names[0]).toHaveLength(LONG_LINE_MARKERS * 3 - 3);
  });

  it('lets the thumbnails row of a document with thumbnails pass', () => {
    const { entries } = parseDjvusedDirectory(lines(['1', '   1 P      140  p.djvu', '     T          <thumbnails>']));
    expect(entries).toHaveLength(1);
  });

  it(`refuses more than ${DJVU_MAX_PAGES} pages by the count alone, and takes ${DJVU_MAX_PAGES}`, () => {
    expect(() => parseDjvusedDirectory(lines([String(DJVU_MAX_PAGES + 1)]))).toThrowError(expect.objectContaining({ name: 'PayloadLimitError', status: 413 }));
    expect(parseDjvusedDirectory(dogvDirectory(DJVU_MAX_PAGES)).pageCount).toBe(DJVU_MAX_PAGES);
  });

  it('refuses a document with no page, and a count that disagrees with the page files', () => {
    expect(() => parseDjvusedDirectory(lines(['0', '     I      140  dict.iff']))).toThrowError(expect.objectContaining({ name: 'CorruptStreamError', message: expect.stringContaining('no page') }));
    expect(() => parseDjvusedDirectory(lines(['2', '   1 P      140  a.djvu']))).toThrowError(expect.objectContaining({ message: expect.stringContaining('do not agree') }));
    expect(() => parseDjvusedDirectory(lines(['1', '   1 P      140  a.djvu', '   2 P      140  b.djvu']))).toThrowError(expect.objectContaining({ message: expect.stringContaining('do not agree') }));
  });

  it.each([
    ['an empty output', ''],
    ['text that is no count', 'unrecognized command\n'],
    ['a directory line of another shape', '1\n   1 Q      140  a.djvu\n'],
    ['a size line among the files', '1\n   1 P      140  a.djvu\nwidth=64 height=64\n'],
  ])('refuses %s', (_name, output) => {
    expect(() => parseDjvusedDirectory(output)).toThrowError(expect.objectContaining({ name: 'ConversionFailedError' }));
  });
});

describe('the sizes of the pages', () => {
  it('reads the size of each page, and a rotation after it', () => {
    expect(parseDjvusedSizes(lines([PAGE_SIZE_LINE, 'width=64 height=64 rotation=1']), 2)).toEqual([
      { width: 4958, height: 7017 },
      { width: 64, height: 64 },
    ]);
  });

  it('refuses a page over the pixel limit of the image inputs, and a page of no size', () => {
    const side = Math.floor(Math.sqrt(DEFAULT_MAX_INPUT_PIXELS)) + 1;
    expect(() => parseDjvusedSizes(lines([`width=${side} height=${side}`]), 1)).toThrowError(expect.objectContaining({ name: 'InputPixelLimitError', status: 413 }));
    expect(() => parseDjvusedSizes(lines(['width=0 height=100']), 1)).toThrowError(expect.objectContaining({ name: 'CorruptStreamError' }));
    expect(parseDjvusedSizes(lines(['width=10000 height=10000']), 1)).toHaveLength(1);
  });

  it('refuses a page without a size and a size without a page, the pages that a page-flagged file of another kind leaves out', () => {
    expect(() => parseDjvusedSizes(lines([PAGE_SIZE_LINE]), 2)).toThrowError(expect.objectContaining({ message: expect.stringContaining('do not agree') }));
    expect(() => parseDjvusedSizes(lines([PAGE_SIZE_LINE, PAGE_SIZE_LINE]), 1)).toThrowError(expect.objectContaining({ message: expect.stringContaining('do not agree') }));
    expect(() => parseDjvusedSizes('', 1)).toThrowError(expect.objectContaining({ message: expect.stringContaining('do not agree') }));
  });

  it.each([
    ['a size with a unit', 'width=64px height=64\n'],
    ['a directory line', '   1 P      140  a.djvu\n'],
  ])('refuses %s', (_name, output) => {
    expect(() => parseDjvusedSizes(output, 1)).toThrowError(expect.objectContaining({ name: 'ConversionFailedError' }));
  });
});
