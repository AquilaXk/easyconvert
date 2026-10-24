import { describe, expect, it } from 'vitest';
import { prepareIgesForKernel } from '../src/lib/conversions/cad-iges-preflight';
import { UnprocessableCadInputError } from '../src/lib/types';
import { DEFAULT_GLOBAL, igesFile, igesRecords } from './helpers/iges-builder';
import { globalParameters } from './helpers/iges-entities';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The checks made on an IGES file before the kernel reads it (src/lib/conversions/cad-iges-preflight.ts): the Terminate line must
 * count the records the file holds, and a Hollerith count of the Global section that the file itself shows to be too large is
 * repaired. What the kernel makes of the repaired file is judged in cad-occt-real-samples.test.ts. The files here are the real
 * ones of the corpus and small ones written by tests/helpers/iges-builder.ts.
 */

const REAL_IGES = ['occt-bearing.iges', 'occt-hammer.iges', 'pyocc-example_45_faces.iges', 'pyocc-sunglasses_lens.igs', 'pyocc-testfile.igs'] as const;

function refusalOf(input: Buffer): UnprocessableCadInputError {
  try {
    prepareIgesForKernel(input);
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableCadInputError);
    expect((error as UnprocessableCadInputError).status).toBe(422);
    return error as UnprocessableCadInputError;
  }
  throw new Error('expected the file to be refused');
}

function differingBytes(a: Buffer, b: Buffer): number[] {
  const at: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) at.push(i);
  return at;
}

const globalOf = (file: Buffer): string[] => globalParameters(file.toString('latin1'));

const noDelimiter = (count: string, parameter: number): string =>
  `The IGES Global section declares a text of ${count} characters in parameter ${parameter} that no delimiter follows: the count is wrong, and every later parameter (the length unit among them) would be read in the wrong place.`;

describe('the Global section of a real file with a wrong Hollerith count', () => {
  it('is repaired to the 32 characters of the file name, changing that count and nothing else', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pyocc-testfile.igs');
    const before = globalOf(bytes);
    const repaired = prepareIgesForKernel(bytes);
    const after = globalOf(repaired);
    // Parameter 4 is the file name, 14 the unit flag and 15 the unit name; the list also holds the two delimiters as its first entries.
    expect(after[3]).toBe('C:\\Users\\PP\\Desktop\\testfile.igs');
    expect(after[3]).toHaveLength(32);
    expect(after[13]).toBe('2');
    expect(after[14]).toBe('MM');
    expect(before[3]).not.toBe(after[3]);
    expect(repaired.length).toBe(bytes.length);
    expect(differingBytes(bytes, repaired)).toHaveLength(1);
    expect(repaired.toString('latin1').split('\r\n')[2].startsWith('32HC:\\Users\\PP\\Desktop\\testfile.igs,')).toBe(true);
  });
});

describe('the other real files', () => {
  for (const id of REAL_IGES.filter((name) => name !== 'pyocc-testfile.igs')) {
    it(`${id} reaches the kernel byte for byte, Hollerith text across records included`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      expect(prepareIgesForKernel(bytes).equals(bytes)).toBe(true);
    });
  }
});

describe('a Hollerith count that is too large', () => {
  const long = 'x'.repeat(96);
  /** The count of `text` is two more than its length: the text, its delimiter and a blank are counted, so the next parameter is swallowed. */
  const withCount = (count: number, text: string, rest = '7,2HMM,1,0.254;'): string => `1H,,1H;,${count}H${text}, ${rest}`;

  it('is rewritten to the length of the text in the same width, so no record moves', () => {
    const file = igesFile({ global: withCount(98, long) });
    const repaired = prepareIgesForKernel(file);
    expect(repaired.length).toBe(file.length);
    expect(globalOf(repaired).slice(2)).toEqual([long, '7', 'MM', '1', '0.254']);
  });

  it('keeps the width of the count when the corrected one has fewer digits', () => {
    const file = igesFile({ global: withCount(100, 'y'.repeat(98)) });
    const repaired = prepareIgesForKernel(file);
    expect(repaired.toString('latin1')).toContain('1H,,1H;,098Hyyy');
    expect(globalOf(repaired)[2]).toBe('y'.repeat(98));
  });

  it('is found when the digits of the count, the text and the delimiter lie in different records', () => {
    const text = `spans two records:${'z'.repeat(20)}`;
    const global = `1H,,1H;, ${'7,'.repeat(31)}40H${text}, 5,2HMM;`;
    const repaired = prepareIgesForKernel(igesFile({ global }));
    const parameters = globalOf(repaired);
    expect(parameters.slice(parameters.indexOf(text), parameters.indexOf(text) + 3)).toEqual([text, '5', 'MM']);
  });

  it('is left alone when the delimiter follows the text, blanks between included', () => {
    for (const global of ['1H,,1H;,5Ha,b,c,3H   ,7;', '1H,,1H;,3Hab   ,7;', '1H,,1H;,3Habc   ,7;']) {
      const file = igesFile({ global });
      expect(prepareIgesForKernel(file).equals(file), global).toBe(true);
    }
  });

  it('is left alone when the first parameter is omitted and the delimiters are the defaults', () => {
    const file = igesFile({ global: ',,4Hname,5Ha;b,c,7;' });
    expect(prepareIgesForKernel(file).equals(file)).toBe(true);
  });

  it('is refused, with the count named, when the text is longer than the count and no delimiter ends it', () => {
    const failure = refusalOf(igesFile({ global: '1H,,1H;,4Hname,6Habcdefgh,7;' }));
    expect(failure.message).toBe(noDelimiter('6', 4));
  });

  it('is refused when the count runs past the end of the Global section, however large it is', () => {
    for (const [count, named] of [['5000', '5000'], ['999999999', '999999999'], ['1000000000', 'more than 999999999'], ['99999999999999999999', 'more than 999999999']]) {
      const failure = refusalOf(igesFile({ global: `1H,,1H;,${count}Habc,7;` }));
      expect(failure.message, count).toBe(noDelimiter(named, 3));
    }
  });

  it('is repaired in time when a hundred thousand counts are too large', () => {
    const file = igesFile({ global: `1H,,1H;,${'3Hab,'.repeat(100_000)}7;` });
    const started = performance.now();
    const repaired = prepareIgesForKernel(file);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(repaired.length).toBe(file.length);
    expect(globalOf(repaired).slice(2, 5)).toEqual(['ab', 'ab', 'ab']);
  });
});

describe('the Terminate line', () => {
  it('lets a complete file through unchanged, with LF, CR LF, CR or no line ends at all', () => {
    for (const lineEnd of ['\n', '\r\n', '\r', '']) {
      const file = igesFile({}, lineEnd);
      expect(prepareIgesForKernel(file).equals(file), JSON.stringify(lineEnd)).toBe(true);
    }
  });

  it.each([
    ['S', 'Start', 0],
    ['G', 'Global', 1],
    ['D', 'Directory Entry', 2],
    ['P', 'Parameter Data', 3],
  ] as const)('is refused with the %s count named when it disagrees with the records of the file', (_letter, section, index) => {
    const records = igesRecords();
    const terminate = records[records.length - 1];
    const field = terminate.slice(index * 8, index * 8 + 8);
    const wrong = `${field[0]}${String(Number(field.slice(1)) + 41).padStart(7, '0')}`;
    records[records.length - 1] = terminate.slice(0, index * 8) + wrong + terminate.slice(index * 8 + 8);
    const failure = refusalOf(Buffer.from(records.join('\r\n') + '\r\n', 'latin1'));
    expect(failure.message).toBe(`The IGES file is cut off or damaged: its Terminate line counts ${Number(field.slice(1)) + 41} ${section} records, but the file holds ${Number(field.slice(1))}.`);
  });

  it('is refused when a count is astronomically large', () => {
    const records = igesRecords();
    records[records.length - 1] = `S0000001G0000002D9999999P0000001`.padEnd(72) + 'T      1';
    expect(refusalOf(Buffer.from(records.join('\n'), 'latin1')).message).toBe('The IGES file is cut off or damaged: its Terminate line counts 9,999,999 Directory Entry records, but the file holds 2.');
  });

  it('is refused when the file is cut off in any record or in the middle of one', () => {
    const file = igesFile({ entities: 12 });
    const text = file.toString('latin1');
    for (let cut = 80; cut < text.length - 2; cut += 37) {
      const failure = refusalOf(file.subarray(0, cut));
      expect(failure.message, `cut at ${cut}`).toMatch(/^The IGES file is cut off or damaged: /);
    }
  });

  it('is refused for records removed from the middle, and for a second Terminate line', () => {
    const records = igesRecords({ entities: 5 });
    const withoutParameter = [...records.slice(0, -3), records[records.length - 1]];
    expect(refusalOf(Buffer.from(withoutParameter.join('\n'), 'latin1')).message).toBe('The IGES file is cut off or damaged: its Terminate line counts 5 Parameter Data records, but the file holds 3.');
    const twice = [...records, records[records.length - 1]];
    expect(refusalOf(Buffer.from(twice.join('\n'), 'latin1')).message).toBe('The IGES file is cut off or damaged: it has 2 Terminate lines where the format has one.');
  });

  it('is refused when it is malformed', () => {
    const records = igesRecords();
    records[records.length - 1] = 'S0000001G00000x2D0000002P0000001'.padEnd(72) + 'T      1';
    expect(refusalOf(Buffer.from(records.join('\n'), 'latin1')).message).toBe('The IGES file is damaged: its Terminate line has no count of Global records.');
  });

  it('is refused when a real file is cut off at any tenth of its records', async (ctx) => {
    for (const id of REAL_IGES) {
      const { bytes } = await requireRealworldSample(ctx, id);
      for (let tenth = 1; tenth < 10; tenth++) {
        const failure = refusalOf(bytes.subarray(0, Math.floor((bytes.length * tenth) / 10)));
        expect(failure.message, `${id} cut at ${tenth}/10`).toMatch(/^The IGES file is cut off or damaged: /);
      }
    }
  });
});

describe('a file that is no IGES file', () => {
  it('goes on to the kernel, which refuses it in its own words', () => {
    for (const text of ['this is not a model\n', 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n', '']) {
      const input = Buffer.from(text);
      expect(prepareIgesForKernel(input).equals(input)).toBe(true);
    }
  });

  it('is judged by its records, not by a section letter in a long line of text', () => {
    const input = Buffer.from(`${'a'.repeat(72)}T${'b'.repeat(7)}\n`);
    expect(prepareIgesForKernel(input).equals(input)).toBe(true);
  });
});

describe('the default Global section the tests write', () => {
  it('is a file the checks accept as it is', () => {
    const file = igesFile({ global: DEFAULT_GLOBAL });
    expect(prepareIgesForKernel(file).equals(file)).toBe(true);
    expect(globalOf(file)[13]).toBe('2');
  });
});
