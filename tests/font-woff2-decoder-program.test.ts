import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeSfnt, decodeWoff2 } from '../src/lib/conversions/font';
import { readSfntTables } from './helpers/font-oracles';
import { skipUnless } from './helpers/strict-skip';
import { pinnedWoff2Program } from './helpers/woff2-programs';
import { COLLECTION_FLAVOR, brotliFont, buildWoff2, collectionHeader, collectionTables, minimalTransformedFont } from './helpers/woff2-builder';

/**
 * The pinned `woff2_decompress` (scripts/install-woff2.sh, with the header checks of scripts/woff2/src/woff2_decompress.cc) is not
 * what reads a WOFF2 file in the product: the in-process reader is faster than the program at every size (docs/policy-decisions.md,
 * entry 173). It is the second reader of the format in the tests: it must agree with the in-process reader on what both read, and it
 * must survive hostile files within its limits. WOFF2_DECOMPRESS_PATH names the program; otherwise /usr/local/bin.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));
const HEAD_ADJUSTMENT_AT = 8;
/** A run past this is a hang, not a slow program: the files below take milliseconds. */
const RUN_HANG_GUARD_MS = 20_000;
const AS_BYTES = 96 * 1024 * 1024;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const decompressor = pinnedWoff2Program('woff2_decompress');
const available = !skipUnless('the pinned woff2_decompress', decompressor !== null);
// skip-ok: prlimit is part of util-linux (Linux only); the sandbox of the worker needs the same program
const prlimit = spawnSync('prlimit', ['--version']).status === 0;

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  ttf: Buffer | null;
  ms: number;
}

/** Runs the decoder on the file in a directory of its own, under an address space of 96 MiB where prlimit exists. */
function decode(file: Buffer): Run {
  const dir = tmpDir('woff2-decode-');
  const input = path.join(dir, 'input.woff2');
  fs.writeFileSync(input, file);
  const started = Date.now();
  const result = prlimit
    ? spawnSync('prlimit', [`--as=${AS_BYTES}`, '--', decompressor!, input], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS })
    : spawnSync(decompressor!, [input], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
  const output = path.join(dir, 'input.ttf');
  const ttf = fs.existsSync(output) ? fs.readFileSync(output) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, signal: result.signal, stderr: result.stderr, ttf, ms: Date.now() - started };
}

function withoutAdjustment(tables: Map<string, Buffer>): Map<string, Buffer> {
  const head = Buffer.from(tables.get('head')!);
  head.writeUInt32BE(0, HEAD_ADJUSTMENT_AT);
  return new Map(tables).set('head', head);
}

const WOFF2_FILES = [
  'dejavu-sans-latin.reference.woff2',
  'dejavu-serif-hinted-ascii.reference.woff2',
  'synthetic-triplets.reference.woff2',
  'synthetic-cff.reference.woff2',
  'dejavu-sans-latin.fonttools-hmtx.woff2',
  'synthetic-triplets.fonttools-hmtx.woff2',
];

describe.skipIf(!available)('the pinned decoder program reads what the in-process reader reads', () => {
  it.each(WOFF2_FILES)('%s: the same tables, up to the checksum adjustment of the head table', (name) => {
    const woff2 = fixture(name);
    const answer = decode(woff2);
    expect(answer.status, answer.stderr).toBe(0);
    const fromProgram = withoutAdjustment(readSfntTables(answer.ttf!));
    const inProcess = decodeWoff2(woff2, name);
    expect([...fromProgram.keys()].sort()).toEqual(Object.keys(inProcess.tables).sort());
    for (const [tag, table] of Object.entries(inProcess.tables)) {
      const expected = tag === 'head' ? Buffer.from(table.data).fill(0, HEAD_ADJUSTMENT_AT, HEAD_ADJUSTMENT_AT + 4) : table.data;
      expect(fromProgram.get(tag)!.equals(expected), `${name} ${tag}`).toBe(true);
    }
  });

  it('declines a last block that is not padded to four bytes, which the Recommendation allows and the in-process reader accepts', () => {
    const woff2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.woff2'));
    expect(woff2.length % 4).not.toBe(0);
    expect(decode(woff2).status).toBe(1);
    expect(Object.keys(decodeWoff2(woff2, 'sample').tables).length).toBeGreaterThan(0);
  });
});

/** A glyf transform header that claims `numGlyphs` glyphs and carries streams of the given sizes. */
function glyfClaim(numGlyphs: number): Buffer {
  const header = Buffer.alloc(36);
  header.writeUInt16BE(numGlyphs, 4);
  return header;
}

describe.skipIf(!available)('hostile files given to the pinned decoder program', () => {
  const real = fixture('dejavu-sans-latin.reference.woff2');
  const header = (patch: (view: Buffer) => void): Buffer => {
    const copy = Buffer.from(real);
    patch(copy);
    return copy;
  };

  const files: Array<[string, Buffer]> = [
    ['an empty file', Buffer.alloc(0)],
    ['the signature alone', Buffer.from('wOF2')],
    ['a header cut at 40 bytes', real.subarray(0, 40)],
    ['a file cut inside the table directory', real.subarray(0, 60)],
    ['a file cut inside the compressed data', real.subarray(0, real.length - 40)],
    ['a length field that is not the file length', header((b) => b.writeUInt32BE(real.length + 4, 8))],
    ['zero tables', header((b) => b.writeUInt16BE(0, 12))],
    ['65535 tables', header((b) => b.writeUInt16BE(0xffff, 12))],
    ['a total size of 4 GiB', header((b) => b.writeUInt32BE(0xffffffff, 16))],
    ['a compressed size past the file', header((b) => b.writeUInt32BE(0x7fffffff, 20))],
    ['a metadata block past the file', header((b) => { b.writeUInt32BE(real.length - 8, 28); b.writeUInt32BE(0xffffff, 32); })],
    ['a private block past the file', header((b) => { b.writeUInt32BE(real.length - 8, 40); b.writeUInt32BE(0xffffff, 44); })],
    ['a signature that is not WOFF2', header((b) => b.write('wOFF', 0, 'latin1'))],
    [
      'a table of 4 GiB announced by a file of a few hundred bytes',
      buildWoff2({ tables: [{ tag: 'name', data: Buffer.alloc(8), origLength: 0xfffffff0 }], totalSfntSize: 0xffffffff }),
    ],
    [
      'a Brotli stream of 64 MiB of zeros behind a directory of a few bytes',
      buildWoff2({ tables: minimalTransformedFont(), compressed: brotliFont(Buffer.alloc(64 * 1024 * 1024)) }),
    ],
    [
      'a glyf transform of 65535 glyphs with empty streams',
      buildWoff2({ tables: [{ tag: 'glyf', data: glyfClaim(0xffff), version: 0, origLength: 1 << 20, transformLength: 36 }, { tag: 'loca', data: Buffer.alloc(0), version: 0, origLength: 4, transformLength: 0 }] }),
    ],
    [
      'an end-of-stream base-128 number that never ends',
      buildWoff2({ tables: [{ tag: 'name', data: Buffer.alloc(4), rawEntry: [5, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01] }] }),
    ],
    [
      'a collection that lists a table that does not exist',
      buildWoff2({ flavor: COLLECTION_FLAVOR, tables: collectionTables(), afterDirectory: collectionHeader([{ indices: [0, 1, 2, 3, 4, 99] }]) }),
    ],
    [
      'a collection of 255 fonts that share one set of tables',
      buildWoff2({ flavor: COLLECTION_FLAVOR, tables: collectionTables(), afterDirectory: collectionHeader(Array.from({ length: 255 }, () => ({ indices: [0, 1, 2, 3, 4, 5] }))) }),
    ],
  ];

  it.each(files)('stays inside the limits for %s', (name, file) => {
    const answer = decode(file);
    expect(answer.ms, `${name} took too long`).toBeLessThan(RUN_HANG_GUARD_MS);
    // A refusal is exit status 1; a crash would show as a signal (the address space of 96 MiB makes a buffer sized from the header alone one).
    expect(answer.signal, name).toBeNull();
    expect([0, 1], name).toContain(answer.status);
    if (answer.status === 0 && answer.ttf!.toString('latin1', 0, 4) !== 'ttcf') expect(decodeSfnt(answer.ttf!, name).numTables).toBeGreaterThan(0);
  });

  it('survives 150 files with a damaged byte', () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 150; i++) {
      const copy = Buffer.from(real);
      const at = next() % copy.length;
      copy[at] = next() & 0xff;
      const answer = decode(copy);
      expect(answer.signal, `byte ${at} of the DejaVu file`).toBeNull();
      expect([0, 1], `byte ${at}`).toContain(answer.status);
    }
  }, 180_000);
});

describe.skipIf(!available || !prlimit)('the pinned decoder program checks the header before it allocates', () => {
  const real = fixture('dejavu-sans-latin.reference.woff2');
  const withHeader = (patch: (copy: Buffer) => void): Buffer => {
    const copy = Buffer.from(real);
    patch(copy);
    return copy;
  };

  it('declines a header that announces more than the decoder may write, without a 128 MiB buffer', () => {
    const answer = decode(withHeader((b) => b.writeUInt32BE(0xffffffff, 16)));
    expect(answer.status).toBe(1);
    expect(answer.stderr).toMatch(/not that of a font this decoder reads/);
  });

  it('declines more tables than the in-process reader allows', () => {
    const answer = decode(withHeader((b) => b.writeUInt16BE(4097, 12)));
    expect(answer.status).toBe(1);
    expect(answer.stderr).toMatch(/not that of a font this decoder reads/);
  });

  it('declines a length field that is not the size of the file', () => {
    const answer = decode(withHeader((b) => b.writeUInt32BE(real.length + 1, 8)));
    expect(answer.status).toBe(1);
    expect(answer.stderr).toMatch(/not that of a font this decoder reads/);
  });

  it('does not size the buffer from a total size that the file cannot back, and reads the font', () => {
    // 112 MiB announced by a file of 8 KiB: the decoder does not believe the field, and neither does the buffer.
    const answer = decode(withHeader((b) => b.writeUInt32BE(112 * 1024 * 1024, 16)));
    expect(answer.status).toBe(0);
    expect(answer.ttf?.equals(decode(real).ttf ?? Buffer.alloc(0))).toBe(true);
  });
});
