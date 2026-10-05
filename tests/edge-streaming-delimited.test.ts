import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChunkTransformer, type ChunkTransformerFn } from '../src/lib/edge/workers/opfs-vfs.worker';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import { convertFile } from '../src/lib/conversions';
import { DataEncodingError, DataLimitExceededError, DataParseError, UnsupportedOptionError } from '../src/lib/types';
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
    expect(open.message).toBe('Failed to parse CSV: Quoted field unterminated (row 2).');

    const trailing = await rejection(convertStreamed('a,b\n"x"y,1\n', 'csv', 'tsv'));
    expect(trailing.message).toBe('Failed to parse CSV: Trailing quote on quoted field is malformed (row 2).');
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
