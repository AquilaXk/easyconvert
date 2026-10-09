import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { compressXz, createTarArchive, create7zArchive, createZipArchive } from '../src/lib/conversions/archive';
import { convertFile } from '../src/lib/conversions';
import { zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The in-process archive writers take `compressionLevel` the way the native route does: an integer from 0 to 9, where
 * 0 stores without compressing, and anything else is refused with UnsupportedOptionError (HTTP 400) instead of being
 * clamped into range. Stored output is recognised from outside: the zip method read by Python's zipfile, the size of a
 * stored deflate stream, and the bytes `xz -0` writes.
 */
const TOOLS = ['7z', 'xz', 'python3'] as const;
const TEST_TIMEOUT_MS = 120_000;
const TEXT = zipfText(200_000, 61);
const FILES = [{ filename: 'text.txt', buffer: TEXT }];
const REFUSED_LEVELS: unknown[] = [10, -1, 4.5, '5', Number.NaN, 1e9, true];
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

function zipMethods(zip: Buffer): number[] {
  const out = execFileSync(
    'python3',
    ['-c', 'import sys, io, json, zipfile\nprint(json.dumps([i.compress_type for i in zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).infolist()]))'],
    { input: zip, encoding: 'utf8' }
  );
  return JSON.parse(out) as number[];
}

function tarOfText(): Buffer {
  return createTarArchive(FILES, {}, 'text.tar').buffer;
}

describe('level 0 is a real value: it stores', () => {
  oracleTest(
    'zip writes the member with the stored method, and level 9 with deflate',
    [...TOOLS],
    async () => {
      expect(zipMethods((await createZipArchive(FILES, { compressionLevel: 0 }, 'a.zip')).buffer)).toEqual([ZIP_STORED]);
      expect(zipMethods((await createZipArchive(FILES, { compressionLevel: 9 }, 'a.zip')).buffer)).toEqual([ZIP_DEFLATED]);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'tar.gz and gz hold the bytes in stored deflate blocks that gzip reads back',
    [...TOOLS],
    async () => {
      const tar = tarOfText();
      for (const target of ['tar.gz', 'gz'] as const) {
        const stored = await convertFile(tar, 'tar', target, { compressionLevel: 0 }, 'text.tar');
        const compressed = await convertFile(tar, 'tar', target, { compressionLevel: 6 }, 'text.tar');
        expect(stored.buffer.length, target).toBeGreaterThan(TEXT.length);
        expect(compressed.buffer.length, target).toBeLessThan(TEXT.length / 2);
        const roundTrip = zlib.gunzipSync(stored.buffer);
        expect(roundTrip.includes(TEXT), target).toBe(true);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    '7z with an explicit deflate coder stores, and 7-Zip extracts the file',
    [...TOOLS],
    () => {
      const stored = create7zArchive(FILES, { archiveCoder: 'deflate', compressionLevel: 0 }, 'stored.7z');
      const compressed = create7zArchive(FILES, { archiveCoder: 'deflate', compressionLevel: 6 }, 'compressed.7z');
      expect(stored.buffer.length).toBeGreaterThan(TEXT.length);
      expect(compressed.buffer.length).toBeLessThan(TEXT.length / 2);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-level-'));
      try {
        const archive = path.join(dir, 'stored.7z');
        fs.writeFileSync(archive, stored.buffer);
        const bin = getOracleToolPath('7z') as string;
        expect(execFileSync(bin, ['x', '-so', '-y', archive]).equals(TEXT)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'xz is written at xz level 0, not at the default level',
    [...TOOLS],
    () => {
      const bin = getOracleToolPath('xz') as string;
      const level = (n: number): Buffer => execFileSync(bin, [`-${n}`, '-c', '-q'], { input: TEXT });
      expect(level(0).equals(level(6))).toBe(false);
      expect(compressXz(TEXT, { compressionLevel: 0 }).equals(level(0))).toBe(true);
      expect(compressXz(TEXT, { compressionLevel: 9 }).equals(level(9))).toBe(true);
      expect(compressXz(TEXT, {}).equals(level(6))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});

describe('a level that is not an integer from 0 to 9 is refused, not clamped', () => {
  for (const level of REFUSED_LEVELS) {
    const options = { compressionLevel: level } as never;
    oracleTest(
      `${JSON.stringify(level) ?? String(level)} is refused by the zip, 7z, tar.gz, gz and xz writers`,
      [...TOOLS],
      async () => {
        await expect(createZipArchive(FILES, options, 'a.zip')).rejects.toMatchObject({ name: 'UnsupportedOptionError' });
        expect(() => create7zArchive(FILES, options, 'a.7z')).toThrow(expect.objectContaining({ name: 'UnsupportedOptionError' }));
        expect(() => compressXz(TEXT, options)).toThrow(expect.objectContaining({ name: 'UnsupportedOptionError' }));
        const tar = tarOfText();
        for (const target of ['tar.gz', 'gz']) {
          await expect(convertFile(tar, 'tar', target, options, 'text.tar'), target).rejects.toMatchObject({ name: 'UnsupportedOptionError' });
        }
      },
      TEST_TIMEOUT_MS
    );
  }
});
