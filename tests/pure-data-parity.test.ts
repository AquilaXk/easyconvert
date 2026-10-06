import { describe, it, expect } from 'vitest';
import { convertPureData } from '../src/lib/edge/pure/pure-data';
import { convertFile } from '../src/lib/conversions';
import { DataParseError } from '../src/lib/types';

/**
 * The pure data module reads CSV/TSV like the server engine: rows keyed with own properties (a
 * __proto__ column keeps its values), duplicate headers renamed, the delimiter detected the same
 * way, and every field-count or quote problem raised as the server's DataParseError. Oracles:
 * byte-for-byte equality with the server's JSON output, and hand-written expected records.
 */

async function serverJson(input: string, src: string): Promise<string> {
  return (await convertFile(Buffer.from(input, 'utf-8'), src, 'json', {}, `data.${src}`)).buffer.toString('utf-8');
}

function captured(run: () => unknown): Error {
  try {
    run();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the pure data conversion to throw');
}

async function serverError(input: string, src: string): Promise<Error> {
  try {
    await convertFile(Buffer.from(input, 'utf-8'), src, 'json', {}, `data.${src}`);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the server conversion to throw');
}

describe('pure data CSV/TSV parsing matches the server', () => {
  it('keeps columns named like Object.prototype members', async () => {
    const input = '__proto__,constructor,prototype,name\r\n1,2,3,Alice\r\n';
    const pure = convertPureData(input, 'csv', 'json');
    expect(pure.text).toBe(await serverJson(input, 'csv'));
    expect(Object.entries(JSON.parse(pure.text)[0])).toEqual([
      ['__proto__', '1'],
      ['constructor', '2'],
      ['prototype', '3'],
      ['name', 'Alice'],
    ]);
  });

  it('renames duplicate headers and detects the delimiter like the server', async () => {
    for (const [input, src] of [
      ['a,a,a_1,b,a\n1,2,3,4,5\n', 'csv'],
      ['name;price\nKim;4,20\nLee;5,00\n', 'csv'],
      ['x|y\n1|2\n', 'tsv'],
      ['h1\th2\r\n"a"  \tb\r\n\r\n"c\r\nd"\te\r\n', 'tsv'],
    ] as const) {
      expect(convertPureData(input, src, 'json').text).toBe(await serverJson(input, src));
    }
    expect(Object.keys(JSON.parse(convertPureData('a,a,a_1,b,a\n1,2,3,4,5\n', 'csv', 'json').text)[0])).toEqual([
      'a',
      'a_2',
      'a_1',
      'b',
      'a_3',
    ]);
  });

  it('raises the server error for field-count and quote problems even when other rows parse', async () => {
    for (const [input, src] of [
      ['a,b\r\n1,2\r\n3,4,5\r\n6,7\r\n', 'csv'],
      ['a,b,c\n1,2,3\n\n7,8\n', 'csv'],
      ['a,b\n1,2\n"x"y,1\n', 'csv'],
      ['a\tb\n1\t2\n3\t"open\n', 'tsv'],
    ] as const) {
      const server = await serverError(input, src);
      const pure = captured(() => convertPureData(input, src, 'json'));
      expect(pure).toBeInstanceOf(DataParseError);
      expect([pure.message, (pure as DataParseError).row, (pure as DataParseError).line]).toEqual([
        server.message,
        (server as DataParseError).row,
        (server as DataParseError).line,
      ]);
    }
  });
});
