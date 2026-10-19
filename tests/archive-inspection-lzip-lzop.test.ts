import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ARCHIVE_SECURITY_LIMITS, inspectArchive } from '../src/lib/conversions/archive';
import { MAX_INSPECTED_PAYLOAD_BYTES } from '../src/lib/conversions/archive-inspection-sources';
import { decompressLzop } from '../src/lib/conversions/lzop';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

/**
 * Archive inspection lists lzip (`.lz`) and lzop (`.lzo`) files, which the conversion route has read since policy 41:
 * a single compressed file is one entry, a compressed tar is its members. The inputs are real files written by lzip 1.24
 * and lzop 1.04 (tests/fixtures/archive-sources/PROVENANCE); the expected names, sizes and checksums are the literals
 * those tools were given, and `tar` reads the names of the compressed tar as a second opinion.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');
const MIB = 1024 * 1024;
const BYTE_VALUES = 256;

const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURE_DIR, name));

/** The 400-line text of long.txt (15,600 bytes). */
const LONG_TEXT = Buffer.from(Array.from({ length: 400 }, (_unused, i) => `line ${String(i).padStart(4, '0')} of the archive probe payload\n`).join(''));
const TREE_FILES: Readonly<Record<string, Buffer>> = {
  'hello.txt': Buffer.from('hello archive\n'),
  'dir/nested.txt': Buffer.from('nested file\n'),
  'dir/data.bin': Buffer.from(Array.from({ length: BYTE_VALUES }, (_unused, i) => i)),
};

const crc32Hex = (bytes: Buffer): string => zlib.crc32(bytes).toString(16).padStart(8, '0');

describe('inspecting a compressed single file', () => {
  for (const [file, source] of [
    ['long.txt.lz', 'lz'],
    ['long.txt.lzo', 'lzo'],
  ] as const) {
    it(`${file} is one entry with the size and checksum of the file that was compressed`, async () => {
      const archive = fixture(file);
      const report = await inspectArchive(archive, { filename: file });
      expect(report.format).toBe(source);
      expect(report.entries).toEqual([
        { name: 'long.txt', uncompressedSize: LONG_TEXT.length, compressedSize: archive.length, isEncrypted: false, isDirectory: false, crc32: crc32Hex(LONG_TEXT) },
      ]);
      expect(report).toMatchObject({ totalEntries: 1, totalUncompressedBytes: LONG_TEXT.length, totalCompressedBytes: archive.length, isEncrypted: false, extractable: true, unextractableReasons: [] });
    });
  }

  it('a lzip file of two members is one entry holding both', async () => {
    const report = await inspectArchive(fixture('two-members.txt.lz'), { filename: 'two-members.txt.lz' });
    expect(report.entries.map((entry) => [entry.name, entry.uncompressedSize, entry.crc32])).toEqual([['two-members.txt', LONG_TEXT.length, crc32Hex(LONG_TEXT)]]);
  });

  it('the file is told apart by its bytes, not by the name the caller gave', async () => {
    const report = await inspectArchive(fixture('long.txt.lzo'), { filename: 'upload.bin' });
    expect(report.format).toBe('lzo');
    expect(report.entries.map((entry) => entry.name)).toEqual(['upload.bin']);
  });
});

describe('inspecting a compressed tar', () => {
  const treeNames = Object.keys(TREE_FILES).sort();

  for (const [file, format] of [
    ['tree.tar.lz', 'tar.lz'],
    ['tree.tar.lzo', 'tar.lzo'],
  ] as const) {
    it(`${file} lists the members of the tar with their sizes and checksums`, async () => {
      const report = await inspectArchive(fixture(file), { filename: file });
      expect(report.format).toBe(format);
      const files = report.entries.filter((entry) => !entry.isDirectory);
      expect(files.map((entry) => [entry.name, entry.uncompressedSize, entry.crc32]).sort()).toEqual(
        treeNames.map((name) => [name, TREE_FILES[name].length, crc32Hex(TREE_FILES[name])]).sort()
      );
      expect(report.entries.filter((entry) => entry.isDirectory).map((entry) => entry.name.replace(/\/$/, ''))).toEqual(['dir']);
      expect(report.extractable).toBe(true);
    });
  }

  oracleTest('tree.tar.lz holds the names that lzip and tar read from it', ['lzip', 'tar'], async () => {
    const decoded = execFileSync(requireOracleTool('lzip'), ['-dc'], { input: fixture('tree.tar.lz'), maxBuffer: 16 * MIB });
    const listed = execFileSync(requireOracleTool('tar'), ['-tf', '-'], { input: decoded, encoding: 'utf8' });
    const expected = listed.split('\n').filter((line) => line !== '').map((line) => line.replace(/\/$/, '')).sort();
    const report = await inspectArchive(fixture('tree.tar.lz'), { filename: 'tree.tar.lz' });
    expect(report.entries.map((entry) => entry.name.replace(/\/$/, '')).sort()).toEqual(expected);
  });

  oracleTest('tree.tar.lzo holds the names that lzop and tar read from it', ['lzop', 'tar'], async () => {
    const decoded = execFileSync(requireOracleTool('lzop'), ['-dc'], { input: fixture('tree.tar.lzo'), maxBuffer: 16 * MIB });
    const listed = execFileSync(requireOracleTool('tar'), ['-tf', '-'], { input: decoded, encoding: 'utf8' });
    const expected = listed.split('\n').filter((line) => line !== '').map((line) => line.replace(/\/$/, '')).sort();
    const report = await inspectArchive(fixture('tree.tar.lzo'), { filename: 'tree.tar.lzo' });
    expect(report.entries.map((entry) => entry.name.replace(/\/$/, '')).sort()).toEqual(expected);
  });
});

describe('inspecting a bomb or a damaged file', () => {
  oracleTest('a lzip file that expands past the ratio cap is refused as a bomb, not inflated', ['lzip'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-lzip-bomb-'));
    try {
      const bomb = path.join(dir, 'zeros.bin');
      fs.writeFileSync(bomb, Buffer.alloc(40 * MIB));
      execFileSync(requireOracleTool('lzip'), ['-0', '-k', bomb]);
      const archive = fs.readFileSync(`${bomb}.lz`);
      expect(archive.length * ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBeLessThan(40 * MIB);
      const failure = await inspectArchive(archive, { filename: 'zeros.bin.lz' }).catch((err: unknown) => err);
      expect(failure).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lzip file cut short is a typed corrupt-stream refusal', async () => {
    const failure = await inspectArchive(fixture('long.txt.lz').subarray(0, 40), { filename: 'cut.lz' }).catch((err: unknown) => err);
    expect(failure).toMatchObject({ name: 'CorruptStreamError' });
  });

  it('a lzop file cut short is a typed corrupt-stream refusal', async () => {
    const failure = await inspectArchive(fixture('long.txt.lzo').subarray(0, 60), { filename: 'cut.lzo' }).catch((err: unknown) => err);
    expect(failure).toMatchObject({ name: 'CorruptStreamError' });
  });
});

describe('inspection decodes a lzip or lzop file only up to a cap of its own', () => {
  const PIECE_BYTES = 4096;
  const NOISE_BYTES = 400;

  /** `size` bytes of 400 random bytes followed by zeros in every 4 KiB: about 10:1 for lzop and lzip, so the ratio rule is out of the way. */
  function compressible(size: number): Buffer {
    const out = Buffer.alloc(size);
    for (let at = 0; at < size; at += PIECE_BYTES) crypto.randomFillSync(out, at, Math.min(NOISE_BYTES, size - at));
    return out;
  }

  function compressed(tool: 'lzip' | 'lzop', data: Buffer, args: string[]): Buffer {
    return execFileSync(requireOracleTool(tool), args, { input: data, maxBuffer: 256 * MIB });
  }

  it('the cap is 64 MiB, below the 500 MB an unpack may reach', () => {
    expect(MAX_INSPECTED_PAYLOAD_BYTES).toBe(64 * MIB);
    expect(MAX_INSPECTED_PAYLOAD_BYTES).toBeLessThan(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
  });

  for (const [tool, args, name] of [
    ['lzop', ['-1', '-c'], 'big.bin.lzo'],
    ['lzip', ['-1', '-c'], 'big.bin.lz'],
  ] as const) {
    oracleTest(
      `${name}: a payload just under the cap is listed, one just over it is refused as too large to inspect`,
      [tool],
      async () => {
        const under = compressible(MAX_INSPECTED_PAYLOAD_BYTES - MIB);
        const report = await inspectArchive(compressed(tool, under, [...args]), { filename: name });
        expect(report.entries.map((entry) => [entry.name, entry.uncompressedSize, entry.crc32])).toEqual([['big.bin', under.length, crc32Hex(under)]]);

        const over = compressible(MAX_INSPECTED_PAYLOAD_BYTES + MIB);
        const archive = compressed(tool, over, [...args]);
        expect(archive.length * ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBeGreaterThan(over.length);
        const failure = await inspectArchive(archive, { filename: name }).catch((err: unknown) => err);
        expect(failure).toMatchObject({ name: 'UnsafeArchiveError', reason: 'uncompressed-size' });
        expect((failure as Error).message).toBe(`Archive bomb detected: uncompressed size exceeds limit of ${MAX_INSPECTED_PAYLOAD_BYTES} bytes (64MB)`);
      },
      120_000
    );
  }

  it('lzop output is written into one buffer of its own size: no second copy of the whole payload is made', () => {
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const archive = fixture('multiblock.txt.lzo');
      const decoded = decompressLzop(archive, 4 * MIB);
      expect(decoded.length).toBe(468_000);
      expect(decoded.buffer.byteLength).toBeGreaterThanOrEqual(decoded.length);
      const copies = concat.mock.calls.filter(([parts]) => (parts as Uint8Array[]).reduce((sum, part) => sum + part.length, 0) >= decoded.length);
      expect(copies).toEqual([]);
    } finally {
      concat.mockRestore();
    }
  });
});
