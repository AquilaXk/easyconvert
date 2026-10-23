import { describe, expect, it } from 'vitest';
import { CidWidthReader } from '../src/lib/conversions/pdf-cid-widths';
import type { PdfArray, PdfValue } from '../src/lib/conversions/pdf-document';

/**
 * /W (ISO 32000-1 section 9.7.4.3) as pdfjs reads it (`extractWidths`, evaluator.js): `c [w1 w2 ...]` gives consecutive
 * CIDs from c their widths, `c1 c2 w` gives the CIDs c1 to c2 one width; a start that is no integer ends the array, a width
 * that is no number is skipped, and a later entry for a CID wins. The reads are bounded: a pair costs at most the CIDs asked
 * for, and one reader stops giving widths when its steps are spent.
 */

const array = (...items: PdfValue[]): PdfArray => ({ kind: 'array', items });
const noReference = (value: PdfValue | undefined): PdfValue => value ?? null;
const reader = (limit?: number): CidWidthReader => new CidWidthReader(noReference, limit);
const widthsOf = (value: PdfValue, first = 3, last = 5, limit?: number): Array<[number, number]> => [...reader(limit).read(value, first, last)];

describe('the widths /W gives the CIDs asked for', () => {
  it('lists consecutive CIDs from the start of a nested array and ranges of CIDs by one width', () => {
    expect(widthsOf(array(3, array(10, 20), 5, 6, 30))).toEqual([[3, 10], [4, 20], [5, 30]]);
  });

  it('skips a width that is no number and lets a later entry for a CID win', () => {
    expect(widthsOf(array(3, array(10, null, 30), 3, array(99)))).toEqual([[3, 99], [5, 30]]);
  });

  it('ends at a start that is no integer, keeping what came before', () => {
    expect(widthsOf(array(3, array(10), 4.5, array(20), 5, array(30)))).toEqual([[3, 10]]);
    expect(widthsOf(array(3, array(10), { kind: 'name', value: 'x' }, array(20)))).toEqual([[3, 10]]);
  });

  it('clips an array that starts below the first CID and one that runs past the last', () => {
    expect(widthsOf(array(1, array(7, 8, 9, 10, 11, 12, 13)))).toEqual([[3, 9], [4, 10], [5, 11]]);
  });

  it('gives nothing for a start past the last CID or far below the first', () => {
    expect(widthsOf(array(100, array(1)))).toEqual([]);
    expect(widthsOf(array(-1e9, array(1, 2, 3)))).toEqual([]);
    expect(widthsOf(array(1e300, array(1)))).toEqual([]);
  });

  it('clips a range to the CIDs asked for and skips a range whose width is no number', () => {
    expect(widthsOf(array(0, 4, 7))).toEqual([[3, 7], [4, 7]]);
    expect(widthsOf(array(4, 9, null, 3, 3, 8))).toEqual([[3, 8]]);
  });

  it('gives nothing for a value that is no array', () => {
    expect(widthsOf(null)).toEqual([]);
    expect(widthsOf(12)).toEqual([]);
  });
});

describe('the bounds of one reader', () => {
  const longArray = array(...Array.from({ length: 100_000 }, () => 0));

  it('costs a pair one step however long its array is when the start is far below the CIDs asked for', () => {
    const subject = reader();
    subject.read(array(...Array.from({ length: 1_000 }, () => [-1e9, longArray]).flat()), 3, 171);
    expect(subject.stepsUsed).toBeLessThan(5_000);
  });

  it('costs a pair at most the CIDs asked for however long its array is', () => {
    const subject = reader();
    subject.read(array(...Array.from({ length: 1_000 }, () => [3, longArray]).flat()), 3, 171);
    expect(subject.stepsUsed).toBeLessThanOrEqual(1_000 * (1 + 169));
  });

  it('gives no width at all once its steps are spent, whatever the array lists', () => {
    const listed = array(3, array(1, 2, 3));
    expect(widthsOf(listed, 3, 5, 100)).toEqual([[3, 1], [4, 2], [5, 3]]);
    expect(widthsOf(array(...Array.from({ length: 200 }, () => [3, array(1)]).flat()), 3, 5, 100)).toEqual([]);
  });

  it('keeps giving no width once spent, even for an array small enough to have fitted', () => {
    const subject = reader(10);
    expect([...subject.read(array(...Array.from({ length: 20 }, () => [3, array(1)]).flat()), 3, 5)]).toEqual([]);
    expect([...subject.read(array(3, array(1)), 3, 5)]).toEqual([]);
  });

  it('reads an array once however many fonts name it and however the steps are spent after', () => {
    const shared = array(3, array(1, 2, 3));
    const subject = reader(4);
    const first = [...subject.read(shared, 3, 5)];
    expect(first).toEqual([[3, 1], [4, 2], [5, 3]]);
    expect([...subject.read(shared, 3, 5)]).toEqual(first);
    expect(subject.stepsUsed).toBe(4);
  });

  it('reads an array once for each span of CIDs asked for', () => {
    const shared = array(3, array(1, 2, 3));
    const subject = reader();
    expect([...subject.read(shared, 3, 3)]).toEqual([[3, 1]]);
    expect([...subject.read(shared, 3, 5)]).toEqual([[3, 1], [4, 2], [5, 3]]);
  });
});
