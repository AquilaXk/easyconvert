import { describe, expect, it } from 'vitest';
import { readToUnicodeCoverage, type ToUnicodeCoverage } from '../src/lib/conversions/pdf-tounicode-coverage';

/**
 * Which codes a /ToUnicode CMap gives text, as pdf.js 6.3.289 reads it (`parseCMap`, `parseBfChar`, `parseBfRange`,
 * `parseCidChar`, `parseCidRange`; `mapBfRange` throws past 2^24 - 1 codes and `parseCMap` goes on after a thrown entry).
 */

function coverageOf(cmap: string): ToUnicodeCoverage {
  const read = readToUnicodeCoverage(cmap);
  if (read === 'inherits') throw new Error('the CMap names another CMap');
  return read;
}

const covered = (cmap: string, upTo = 0x100): number[] => {
  const read = coverageOf(cmap);
  return Array.from({ length: upTo }, (_, code) => code).filter((code) => read.covers(code));
};

describe('the codes of a ToUnicode CMap that have text', () => {
  it('are the codes of its bfchar entries', () => {
    expect(covered('1 beginbfchar\n<0003> <0041>\n<0010> <0042>\nendbfchar')).toEqual([3, 0x10]);
  });

  it('are the codes of a bfrange to a string, from the low code to the high one', () => {
    expect(covered('beginbfrange\n<0010> <0012> <0041>\nendbfrange')).toEqual([0x10, 0x11, 0x12]);
  });

  it('are the codes of a bfrange to an array, as many as the array holds', () => {
    expect(covered('beginbfrange\n<0010> <0020> [<0041> <0042>]\nendbfrange')).toEqual([0x10, 0x11]);
  });

  it('are the codes of cidchar and cidrange entries, which Poppler and pdf.js both accept in a ToUnicode CMap', () => {
    expect(covered('begincidchar\n<0005> 65\nendcidchar\nbegincidrange\n<0010> <0011> 66\nendcidrange')).toEqual([5, 0x10, 0x11]);
  });

  it('leave out a code whose destination is empty, which pdf.js reads as no text', () => {
    const read = coverageOf('beginbfchar\n<0003> <>\n<0004> <0041>\nendbfchar');
    expect([read.listsCodes, read.covers(3), read.covers(4)]).toEqual([true, false, true]);
  });

  it('stop at endcmap, as pdf.js does', () => {
    expect(covered('beginbfchar\n<0003> <0041>\nendbfchar\nendcmap\nbeginbfchar\n<0004> <0041>\nendbfchar')).toEqual([3]);
  });

  it('leave out a bfrange wider than pdf.js maps and one that ends before it starts', () => {
    const read = coverageOf('beginbfrange\n<0000> <FFFFFFFF> <0000>\n<0020> <0010> <0000>\nendbfrange');
    expect([read.listsCodes, read.covers(0), read.covers(0x15)]).toEqual([false, false, false]);
  });

  it('skip an entry that does not parse and read the next', () => {
    expect(covered('beginbfchar\n<0003>\nendbfchar\nbeginbfchar\n<0004> <0041>\nendbfchar')).toEqual([4]);
  });

  it('are not the whole map of a CMap that names another with usecmap', () => {
    expect(readToUnicodeCoverage('/Identity-H usecmap\nbeginbfchar\n<0003> <0041>\nendbfchar')).toBe('inherits');
  });

  it('list no code in a CMap of codespace ranges and words that only look like blocks', () => {
    expect(coverageOf('begincodespacerange <0000> <FFFF> endcodespacerange beginbfchar constructor toString').listsCodes).toBe(false);
  });

  it('cost the number of tokens when 100,000 ranges each span the whole code space', () => {
    const started = performance.now();
    const read = coverageOf(`beginbfrange\n${'<0000> <FFFF> <0020>\n'.repeat(100_000)}endbfrange`);
    expect(read.covers(0xffff)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
