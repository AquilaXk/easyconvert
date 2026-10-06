import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChunkTransformer, runOpfsWorkerJob, type ChunkTransformerFn } from '../src/lib/edge/workers/opfs-vfs.worker';
import { rehydrateWorkerError, serializeWorkerError } from '../src/lib/edge/workers/worker-errors';
import { streamConvertWithOpfs } from '../src/lib/edge/pipelines/opfs-streaming-pipeline';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import { convertFile } from '../src/lib/conversions';
import {
  ConversionFailedError,
  DataEncodingError,
  DataLimitExceededError,
  DataParseError,
  DataRepresentationError,
  UnsupportedOptionError,
} from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The browser L3 streaming path for large CSV <-> TSV files applies the server's delimited-output
 * rules: formula cells escaped unless they are numeric literals, a UTF-8 BOM on by default for CSV
 * and off for TSV, the `bom` and `escapeFormulas` options, RFC 4180 quoting, and strict UTF-8
 * input with a typed error instead of U+FFFD. Oracles: Python's csv module reads every output,
 * hand-written expected bytes, and byte-for-byte parity with the server engine's output.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const LARGE_FILE_BYTES = 150 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;
/** Generous bound for streaming 4 MiB of quoted CR-only records; a quadratic line count takes tens of seconds. */
const LINEAR_TIME_BOUND_MS = 2000;

const CSV_INPUT =
  'name,formula,note\r\n"Kim, Min",=SUM(A1:A2),"says ""hi"""\r\n이름,-5,"line1\nline2"\r\n"Tab\there",@cmd,+1.5e3\r\n';
const EXPECTED_ROWS = [
  ['name', 'formula', 'note'],
  ['Kim, Min', "'=SUM(A1:A2)", 'says "hi"'],
  ['이름', '-5', 'line1\nline2'],
  ['Tab\there', "'@cmd", '+1.5e3'],
];

/** Streams the bytes through the transformer in the given chunk lengths and joins the output. */
async function stream(transformer: ChunkTransformerFn, bytes: Uint8Array, cuts: number[]): Promise<Buffer> {
  const out: Uint8Array[] = [];
  let start = 0;
  for (const end of [...cuts, bytes.byteLength]) {
    out.push(await transformer(bytes.subarray(start, end), start, bytes.byteLength));
    start = end;
  }
  return Buffer.concat(out);
}

async function convertStreamed(input: string | Uint8Array, src: string, tgt: string, options: Record<string, unknown> = {}, cuts: number[] = []): Promise<Buffer> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return stream(resolveChunkTransformer(src, tgt, options), bytes, cuts);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the streamed conversion to be rejected');
}

/** Rows as Python's csv module reads them (utf-8-sig strips a BOM). */
function pythonRows(bytes: Buffer, delimiter: string): string[][] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stream-delimited-'));
  try {
    const file = path.join(dir, 'out.txt');
    writeFileSync(file, bytes);
    const script = 'import csv, json, sys\nprint(json.dumps(list(csv.reader(open(sys.argv[1], newline="", encoding="utf-8-sig"), delimiter=sys.argv[2]))))';
    return JSON.parse(execFileSync(requireOracleTool('python3'), ['-c', script, file, delimiter], { encoding: 'utf-8' })) as string[][];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('streamed CSV <-> TSV applies the server output rules', () => {
  oracleTest('writes TSV without a BOM, escaping formula cells but not numeric literals', ['python3'], async () => {
    const tsv = await convertStreamed(CSV_INPUT, 'csv', 'tsv');
    expect([...tsv.subarray(0, 4)]).toEqual([...Buffer.from('name')]);
    expect(pythonRows(tsv, '\t')).toEqual(EXPECTED_ROWS);
  });

  oracleTest('writes CSV with a UTF-8 BOM by default', ['python3'], async () => {
    const tsvInput = 'a\tb\n=1+1\tx,y\n-7\t@z\n';
    const csv = await convertStreamed(tsvInput, 'tsv', 'csv');
    expect([...csv.subarray(0, 3)]).toEqual(UTF8_BOM);
    expect(csv.toString('utf-8')).toBe('﻿a,b\r\n"\'=1+1","x,y"\r\n-7,"\'@z"');
    expect(pythonRows(csv, ',')).toEqual([['a', 'b'], ["'=1+1", 'x,y'], ['-7', "'@z"]]);
  });

  it('produces the same bytes as the server engine', async () => {
    const tsvInput = Buffer.from(new TextDecoder().decode(await convertStreamed(CSV_INPUT, 'csv', 'tsv')), 'utf-8');
    for (const [src, tgt, input] of [
      ['csv', 'tsv', Buffer.from(CSV_INPUT, 'utf-8')],
      ['tsv', 'csv', tsvInput],
    ] as const) {
      for (const options of [{}, { bom: true }, { bom: false }, { escapeFormulas: false }]) {
        const server = await convertFile(input, src, tgt, options, `data.${src}`);
        const streamed = await convertStreamed(input, src, tgt, options);
        expect(streamed.toString('hex')).toBe(server.buffer.toString('hex'));
      }
    }
  });

  it('honours bom and escapeFormulas', async () => {
    const plain = await convertStreamed('v\n=1+1\n', 'tsv', 'csv', { bom: false, escapeFormulas: false });
    expect(plain.toString('utf-8')).toBe('v\r\n=1+1');
    const tsvWithBom = await convertStreamed('v\n@x\n', 'csv', 'tsv', { bom: true });
    expect(tsvWithBom.toString('utf-8')).toBe('﻿v\r\n"\'@x"');
  });

  it('gives the same output however the input is split into chunks', async () => {
    const bytes = new TextEncoder().encode(CSV_INPUT);
    const whole = await convertStreamed(bytes, 'csv', 'tsv');
    // Every cut point, including inside quoted fields, escaped quotes, CRLF pairs and the 3-byte Hangul sequences.
    for (let cut = 1; cut < bytes.byteLength; cut++) {
      expect((await convertStreamed(bytes, 'csv', 'tsv', {}, [cut])).equals(whole)).toBe(true);
    }
    const singleBytes = Array.from({ length: bytes.byteLength - 1 }, (_, index) => index + 1);
    expect((await convertStreamed(bytes, 'csv', 'tsv', {}, singleBytes)).equals(whole)).toBe(true);
  });

  it('keeps each output chunk proportional to its input chunk', async () => {
    const record = 'id,value,=formula\n';
    const chunk = new TextEncoder().encode(record.repeat(Math.floor(STREAM_CHUNK_BYTES / record.length)));
    const transformer = resolveChunkTransformer('csv', 'tsv', {});
    const chunks = 12;
    const total = chunk.byteLength * chunks;
    let largest = 0;
    for (let index = 0; index < chunks; index++) {
      const out = await transformer(chunk, index * chunk.byteLength, total);
      largest = Math.max(largest, out.byteLength);
    }
    // Quoting and the ' prefix add at most a few bytes per record; nothing accumulates across chunks.
    expect(largest).toBeLessThan(chunk.byteLength * 2);
    expect(largest).toBeGreaterThan(chunk.byteLength / 2);
  });
});

/** Byte-for-byte comparison with the server engine at the given cut points of the input. */
async function expectServerParity(input: string, src: string, tgt: string, cutSets: number[][], options: Record<string, unknown> = {}): Promise<Buffer> {
  const bytes = Buffer.from(input, 'utf-8');
  const server = (await convertFile(bytes, src, tgt, options, `data.${src}`)).buffer;
  for (const cuts of cutSets) {
    const streamed = await convertStreamed(bytes, src, tgt, options, cuts);
    expect({ cuts: cuts.slice(0, 3), hex: streamed.toString('hex') }).toEqual({ cuts: cuts.slice(0, 3), hex: server.toString('hex') });
  }
  return server;
}

function everyCut(length: number): number[][] {
  return [[], ...Array.from({ length: length - 1 }, (_, index) => [index + 1])];
}

describe('streamed CSV <-> TSV matches the server parser', () => {
  const SEMICOLON_CSV = 'name;price;note\r\n"Müller, K";3,50;=1+1\r\nKim;4,20;"a;b"\r\nLee;5,00;plain\r\n';

  oracleTest('detects a semicolon delimiter like the server at every cut point', ['python3'], async () => {
    const server = await expectServerParity(SEMICOLON_CSV, 'csv', 'tsv', everyCut(Buffer.byteLength(SEMICOLON_CSV)));
    expect(pythonRows(server, '\t')).toEqual([
      ['name', 'price', 'note'],
      ['Müller, K', '3,50', "'=1+1"],
      ['Kim', '4,20', 'a;b'],
      ['Lee', '5,00', 'plain'],
    ]);
  });

  it('decides the delimiter from the first 50 records of a multi-chunk file like the server', async () => {
    // More than 1 MiB, so the sample is decided before the end of the input, in several chunk layouts.
    const records = Array.from({ length: 60_000 }, (_, index) => `${index};"v ${index}";=x${index % 7}`);
    const input = `id;value;formula\n${records.join('\n')}\n`;
    const size = Buffer.byteLength(input);
    await expectServerParity(input, 'csv', 'tsv', [[], [1_048_576], [700_000, 1_100_000], [3, 1_048_580, size - 2]]);
  });

  it('keeps the format delimiter when it splits the sample, and honours an explicit delimiter', async () => {
    const mixed = 'a,b;c\n1,2;3\n4,5;6\n';
    await expectServerParity(mixed, 'csv', 'tsv', everyCut(Buffer.byteLength(mixed)));
    const explicit = await expectServerParity(mixed, 'csv', 'tsv', [[], [4], [9]], { delimiter: ';' });
    expect(explicit.toString('utf-8')).toBe('a,b\tc\r\n1,2\t3\r\n4,5\t6');
    const pipeTsv = 'x|y\n1|2\n';
    await expectServerParity(pipeTsv, 'tsv', 'csv', everyCut(Buffer.byteLength(pipeTsv)));
  });

  it('renames duplicate headers like the server at every cut point', async () => {
    const duplicates = 'a,a,a_1,b,a,\uFEFFc\r\n1,2,3,4,5,6\r\n';
    const server = await expectServerParity(duplicates, 'csv', 'tsv', everyCut(Buffer.byteLength(duplicates)));
    // Hand-written: Papa-style renaming skips names already used (a_1 is taken, so the second a is a_2).
    expect(server.toString('utf-8')).toBe('a\ta_2\ta_1\tb\ta_3\tc\r\n1\t2\t3\t4\t5\t6');
  });

  it('keeps columns named like Object.prototype members, like the server, at every cut point', async () => {
    const risky = '__proto__,constructor,prototype,name\r\n1,2,3,Alice\r\n4,5,6,Bob\r\n';
    const server = await expectServerParity(risky, 'csv', 'tsv', everyCut(Buffer.byteLength(risky)));
    expect(server.toString('utf-8')).toBe('__proto__\tconstructor\tprototype\tname\r\n1\t2\t3\tAlice\r\n4\t5\t6\tBob');
  });

  oracleTest('uses the single line-break style the server guesses, at every cut point', ['python3'], async () => {
    // An LF file: a bare CR inside an unquoted field is data, not a record end.
    const lf = 'a,b\nx\ry,1\nz,2\n';
    const lfOut = await expectServerParity(lf, 'csv', 'tsv', everyCut(Buffer.byteLength(lf)));
    expect(lfOut.toString('utf-8')).toBe('a\tb\r\n"x\ry"\t1\r\nz\t2');
    expect(pythonRows(lfOut, '\t')).toEqual([['a', 'b'], ['x\ry', '1'], ['z', '2']]);
    // A CRLF file: a bare LF inside an unquoted field is data; CR and LF split across chunks still pair up.
    const crlf = 'a,b\r\nx\ny,1\r\nz,2\r\n';
    const crlfOut = await expectServerParity(crlf, 'csv', 'tsv', everyCut(Buffer.byteLength(crlf)));
    expect(crlfOut.toString('utf-8')).toBe('a\tb\r\n"x\ny"\t1\r\nz\t2');
    // A CR file: a bare LF is data.
    const cr = 'a\tb\rx\t1\ry\nz\t2\r';
    const crOut = await expectServerParity(cr, 'tsv', 'csv', everyCut(Buffer.byteLength(cr)));
    // Hand-written bytes and an independent reader, so a wrong line-break guess is caught, not mirrored.
    expect(crOut.toString('utf-8')).toBe('\uFEFFa,b\r\nx,1\r\n"y\nz",2');
    expect(pythonRows(crOut, ',')).toEqual([['a', 'b'], ['x', '1'], ['y\nz', '2']]);
  });

  it('accepts whitespace between a closing quote and the delimiter or line break, like the server', async () => {
    // An LF file: a CR after a closing quote is whitespace too.
    const spaced = 'h1,h2\n"a"  ,b\n"c"\t,"d" \n"e",f\n"g" \r,h\n';
    const server = await expectServerParity(spaced, 'csv', 'tsv', everyCut(Buffer.byteLength(spaced)));
    expect(server.toString('utf-8')).toBe('h1\th2\r\na\tb\r\nc\td\r\ne\tf\r\ng\th');
  });

  it('reports malformed input with the same error, row and line as the server', async () => {
    const malformed = [
      'a,b\n\n"x,1\n',
      'a,b\n1,2\n\n3,4,5\n',
      'a,b,c\n\n\n1,2\n',
      'a,b\n"x"y,1\n',
      'a,b\n1,"open\nstill open',
      'a,b\n1,"done"  ',
      'a,b\n1,"x" z\n2,y\n',
    ];
    for (const input of malformed) {
      const bytes = Buffer.from(input, 'utf-8');
      const server = await rejection(convertFile(bytes, 'csv', 'tsv', {}, 'bad.csv'));
      expect(server).toBeInstanceOf(DataParseError);
      for (const cuts of everyCut(bytes.byteLength)) {
        const streamed = await rejection(convertStreamed(bytes, 'csv', 'tsv', {}, cuts));
        const errorSummary = (err: Error) => [err.constructor.name, err.message, (err as DataParseError).row, (err as DataParseError).line];
        expect({ input, cuts, error: errorSummary(streamed) }).toEqual({ input, cuts, error: errorSummary(server) });
      }
    }
  });

  it('ends a header-only output with a record separator, like the server, at every cut point', async () => {
    for (const [input, src, tgt, expected] of [
      ['a,b\n', 'csv', 'tsv', 'a\tb\r\n'],
      ['a,b', 'csv', 'tsv', 'a\tb\r\n'],
      ['a\tb\r\n\r\n', 'tsv', 'csv', '\uFEFFa,b\r\n'],
    ] as const) {
      const server = await expectServerParity(input, src, tgt, everyCut(Buffer.byteLength(input)));
      expect(server.toString('utf-8')).toBe(expected);
    }
  });

  it('records the line of quoted fields in linear time', async () => {
    // A CR-only file holds no LF, so every quoted field asks for the line of a position with no LF after it.
    const record = '"a","b"\r';
    const input = new TextEncoder().encode(`h1,h2\r${record.repeat(Math.floor((4 * 1024 * 1024) / record.length))}`);
    const transformer = resolveChunkTransformer('csv', 'tsv', { delimiter: ',' });
    const started = performance.now();
    const out = transformer(input, 0, input.byteLength) as Uint8Array;
    const elapsedMs = performance.now() - started;
    expect(out.byteLength).toBeGreaterThan(input.byteLength / 2);
    expect(elapsedMs).toBeLessThan(LINEAR_TIME_BOUND_MS);
  }, 120_000);

  it('refuses to buffer a delimiter sample beyond its cap', async () => {
    const transformer = resolveChunkTransformer('csv', 'tsv', {});
    const huge = new TextEncoder().encode(`a\n"${'x'.repeat(32 * 1024 * 1024 + 1)}`);
    const err = await rejection(Promise.resolve().then(() => transformer(huge, 0, huge.byteLength + 1)));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err.message).toBe(
      'The first CSV records exceed 33554432 characters before the delimiter can be detected; pass the "delimiter" option.'
    );
  });
});

describe('typed errors survive the Worker boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serialises and rehydrates every data error class with its location', () => {
    const errors = [
      new DataEncodingError('enc'),
      new DataLimitExceededError('limit'),
      new DataParseError('parse', { row: 3, line: 4, column: 5 }),
      new DataRepresentationError('repr'),
      new UnsupportedOptionError('opt'),
    ];
    for (const original of errors) {
      const payload = JSON.parse(JSON.stringify(serializeWorkerError(original)));
      const restored = rehydrateWorkerError(payload);
      expect(restored.constructor).toBe(original.constructor);
      expect(restored).toBeInstanceOf(ConversionFailedError);
      expect(restored.message).toBe(original.message);
      expect(restored.name).toBe(original.name);
    }
    const parse = rehydrateWorkerError(serializeWorkerError(new DataParseError('p', { row: 3, line: 4, column: 5 }))) as DataParseError;
    expect([parse.row, parse.line, parse.column]).toEqual([3, 4, 5]);
    const unknown = rehydrateWorkerError({ name: 'RangeError', message: 'boom' });
    expect(unknown).not.toBeInstanceOf(ConversionFailedError);
    expect([unknown.name, unknown.message]).toEqual(['RangeError', 'boom']);
  });

  it('rejects the main-thread promise with the class the worker threw', async () => {
    const invalidUtf8 = new File([Uint8Array.from([0x61, 0x0a, 0xc7, 0xd1, 0x0a])], 'big.csv', { type: 'text/csv' });
    const posted: Record<string, unknown>[] = [];
    // The worker side: the real job runner posts the serialised error.
    class FakeWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message: string }) => void) | null = null;
      postMessage(data: Record<string, unknown>): void {
        void runOpfsWorkerJob(data, (message) => {
          posted.push(message);
          this.onmessage?.({ data: message });
        });
      }
      terminate(): void {}
    }
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('Worker', FakeWorker);
    const err = await rejection(streamConvertWithOpfs(invalidUtf8, 'csv', 'tsv'));
    expect(err).toBeInstanceOf(DataEncodingError);
    expect(err.message).toBe('Streamed CSV input is not valid UTF-8 text; pass the "encoding" option to convert it on the server.');
    expect(posted.at(-1)).toMatchObject({ type: 'ERROR', error: { name: 'DataEncodingError' } });
  });
});

describe('streamed CSV <-> TSV fails closed', () => {
  it('rejects bytes that are not UTF-8 instead of writing U+FFFD', async () => {
    const cp949 = Uint8Array.from([0x61, 0x2c, 0x62, 0x0a, 0xc7, 0xd1, 0x2c, 0x31, 0x0a]);
    for (const cuts of [[], [5]]) {
      const err = await rejection(convertStreamed(cp949, 'csv', 'tsv', {}, cuts));
      expect(err).toBeInstanceOf(DataEncodingError);
      expect(err.message).toBe(
        'Streamed CSV input is not valid UTF-8 text; pass the "encoding" option to convert it on the server.'
      );
    }
    const truncated = new TextEncoder().encode('a,b\n이,1\n').subarray(0, 6);
    expect(await rejection(convertStreamed(truncated, 'csv', 'tsv'))).toBeInstanceOf(DataEncodingError);
  });

  it('reports ragged records and unterminated quotes with their row', async () => {
    const ragged = await rejection(convertStreamed('a,b\r\n1,2\r\n3,4,5\r\n', 'csv', 'tsv'));
    expect(ragged).toBeInstanceOf(DataParseError);
    expect((ragged as DataParseError).row).toBe(3);
    expect(ragged.message).toBe('Failed to parse CSV: Too many fields: expected 2 fields but parsed 3 (row 3).');

    const short = await rejection(convertStreamed('a\tb\tc\n1\t2\n', 'tsv', 'csv'));
    expect(short.message).toBe('Failed to parse TSV: Too few fields: expected 3 fields but parsed 2 (row 2).');

    const open = await rejection(convertStreamed('a,b\n"x,1\n', 'csv', 'tsv'));
    expect(open).toBeInstanceOf(DataParseError);
    expect(open.message).toBe('Failed to parse CSV: Quoted field unterminated (row 2, line 2).');

    const trailing = await rejection(convertStreamed('a,b\n"x"y,1\n', 'csv', 'tsv'));
    expect(trailing.message).toBe('Failed to parse CSV: Trailing quote on quoted field is malformed (row 2, line 2).');
  });

  it('caps the size of one record so streaming memory stays bounded', async () => {
    const huge = `a\n"${'x'.repeat(16 * 1024 * 1024 + 1)}"\n`;
    const err = await rejection(convertStreamed(huge, 'csv', 'tsv', {}, [8 * 1024 * 1024]));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err.message).toBe('A CSV record is longer than 16777216 characters, more than a streamed conversion holds in memory.');
  });

  it('accepts only a UTF-8 encoding option and leaves other encodings to the server', async () => {
    expect((await convertStreamed('a\n1\n', 'csv', 'tsv', { encoding: 'utf-8' })).toString('utf-8')).toBe('a\r\n1');
    const err = await rejection(convertStreamed('a\n1\n', 'csv', 'tsv', { encoding: 'euc-kr' }));
    expect(err).toBeInstanceOf(UnsupportedOptionError);
    expect(resolveConversionTier('csv', 'tsv', LARGE_FILE_BYTES, { encoding: 'euc-kr' }, { hasOpfsSyncAccess: true }).tier).toBe('L4');
    expect(resolveConversionTier('csv', 'tsv', LARGE_FILE_BYTES, { encoding: 'UTF8' }, { hasOpfsSyncAccess: true }).tier).toBe('L3');
  });
});
