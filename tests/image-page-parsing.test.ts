import { describe, it, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { resolvePageSelection } from '../src/lib/conversions/page-range';
import { InvalidPageRangeError } from '../src/lib/types';
import { runConvert, decodeRgba, sampleAt, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { captureError } from './helpers/capture-error';

/**
 * `page` is a whole number written in decimal digits: a number, or a string of digits with optional
 * surrounding whitespace. Exponent, hexadecimal, signed, fractional and non-scalar values are refused with
 * a clear message instead of being coerced, and whitespace is ignored the same way in `page` and `pages`.
 *
 * Oracles: the expected page numbers are written out in the cases; the animation comes from ImageMagick.
 */

const COUNT = 3;
const outOfRange = (page: number | string, count: number) => new InvalidPageRangeError(`out of range: ${page} of ${count}`);
const resolve = (page: unknown, pages?: unknown) =>
  resolvePageSelection(page as never, pages as never, COUNT, outOfRange);

describe('resolvePageSelection', () => {
  it.each([
    [2, [2]],
    ['2', [2]],
    [' 2 ', [2]],
    ['\t3\n', [3]],
    ['02', [2]],
  ])('accepts %j as page %j', (page, expected) => {
    expect(resolve(page)).toEqual(expected);
  });

  it.each([null, undefined, '', '   '])('treats %j as absent', (page) => {
    expect(resolve(page)).toBeUndefined();
  });

  it.each([
    ['1e0', '"1e0"'],
    ['0x2', '"0x2"'],
    ['2.0', '"2.0"'],
    ['+2', '"+2"'],
    ['two', '"two"'],
    ['2 3', '"2 3"'],
    [2.5, '2.5'],
    [Number.NaN, 'null'],
    [true, 'true'],
    [{}, '{}'],
    [[2], '[2]'],
    [{ valueOf: () => 2 }, '{}'],
  ])('rejects %j with a clear message', (page, shown) => {
    expect(() => resolve(page)).toThrow(InvalidPageRangeError);
    expect(() => resolve(page)).toThrow(`Invalid page ${shown}: use a whole number written in decimal digits`);
  });

  it.each([0, 4, '4', -1, '-1'])('rejects %j as out of range, not as malformed', (page) => {
    expect(() => resolve(page)).toThrow(/out of range/);
  });

  it.each([
    [' 2 ', [2]],
    [' 1 , 3 ', [1, 3]],
  ])('trims pages %j the same way', (pages, expected) => {
    expect(resolve(undefined, pages)).toEqual(expected);
  });

  it('treats whitespace-only pages as absent, like an empty string', () => {
    expect(resolve(undefined, '   ')).toBeUndefined();
    expect(resolve(undefined, '')).toBeUndefined();
  });

  it('agrees page and pages after trimming both', () => {
    expect(resolve(' 2 ', ' 2 ')).toEqual([2]);
    expect(() => resolve('2', ' 3 ')).toThrow(/select different pages/);
  });
});

describe('convertImage page parsing', () => {
  const animation = () =>
    runConvert(['-size', '12x8', '-delay', '10', 'xc:rgb(255,0,0)', 'xc:rgb(0,255,0)', 'xc:rgb(0,0,255)', 'gif:-']);

  it.skipIf(SKIP_WITHOUT_MAGICK)('a padded string selects the frame', async () => {
    const result = await convertImage(animation(), 'png', { page: ' 2 ' as never }, 'a.gif', 'gif');
    expect(result.frameUsed).toBe(2);
    expect(sampleAt(decodeRgba(result.buffer, 'png'), 6, 4).slice(0, 3)).toEqual([0, 255, 0]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each(['1e0', '0x2', {}, [1]])('refuses page %j before decoding any frame', async (page) => {
    const error = await captureError(() => convertImage(animation(), 'png', { page: page as never }, 'a.gif', 'gif'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/^Invalid page /);
  });
});
