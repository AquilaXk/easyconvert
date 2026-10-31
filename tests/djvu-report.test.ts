import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_INPUT_PIXELS } from '../src/lib/conversions/image-input-limits';
import { DJVU_MAX_PAGES } from '../src/lib/conversions/djvu-container';
import { parseDjvusedPageCount, parseDjvusedSizes } from '../src/lib/conversions/djvu-report';

/**
 * The strict reading of what `djvused` prints (src/lib/conversions/djvu-report.ts): `n` first, then `size`. The text is what djvulibre 3.5.28 prints for `wc-dogv-12042005.djvu` and for the documents of
 * tests/djvu-render.test.ts; the programs themselves are run on real and built documents there.
 */

const PAGE_SIZE_LINE = 'width=4958 height=7017';

function lines(rows: readonly string[]): string {
  return `${rows.join('\n')}\n`;
}

describe('the page count of a document', () => {
  it('reads the count of the DOGV document, the one line that `n` prints', () => {
    expect(parseDjvusedPageCount('34\n')).toBe(34);
  });

  it(`refuses more than ${DJVU_MAX_PAGES} pages, and takes ${DJVU_MAX_PAGES}`, () => {
    expect(() => parseDjvusedPageCount(lines([String(DJVU_MAX_PAGES + 1)]))).toThrowError(expect.objectContaining({ name: 'PayloadLimitError', status: 413 }));
    expect(parseDjvusedPageCount(lines([String(DJVU_MAX_PAGES)]))).toBe(DJVU_MAX_PAGES);
  });

  it('refuses a document with no page', () => {
    expect(() => parseDjvusedPageCount('0\n')).toThrowError(expect.objectContaining({ name: 'CorruptStreamError', message: expect.stringContaining('no page') }));
  });

  it.each([
    ['an empty output', ''],
    ['text that is no count', 'unrecognized command\n'],
    ['a count with a sign', '-1\n'],
    ['a second line after the count', '1\n   1 P      140  a.djvu\n'],
    ['a size line after the count', '1\nwidth=64 height=64\n'],
  ])('refuses %s', (_name, output) => {
    expect(() => parseDjvusedPageCount(output)).toThrowError(expect.objectContaining({ name: 'ConversionFailedError', message: expect.stringContaining('does not read') }));
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
