import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { fileDigests, readArchiveTree } from './helpers/archive-output-tree';
import { build7zZeroBomb } from './helpers/hostile-archives';

/**
 * The 100:1 compression ratio is judged only once the decoded output is past 32 MiB; below that, the 500 MB size cap is
 * the only bound. A file of one repeated pattern compresses past 100:1 at sizes that cost nothing to decode, and refusing
 * it refuses a real file. Each source below is at the floor (converts) or one MiB past it (refused as a compression
 * ratio bomb); the unit tests of the safety module hold the exact byte.
 */

const MIB = 1024 * 1024;
const FLOOR_MIB = 32;
const ENGINE_TIMEOUT_MS = 180_000;
const TARGETS = ['zip', 'tar', 'tar.gz', 'tar.bz2', '7z'] as const;
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a typed refusal but the conversion completed');
    },
    (err: unknown) => err
  );
}

describe('a cabinet of 20 MiB of one repeated byte in 36 KB (584:1) converts', () => {
  oracleTest(
    'zeros-20mib.cab (written by gcab) to every target holds the one 20 MiB file',
    ['7z', 'tar'],
    async () => {
      const cab = fs.readFileSync(path.join(FIXTURE_DIR, 'zeros-20mib.cab'));
      expect(cab.length * 100).toBeLessThan(20 * MIB);
      const listing = execFileSync(requireOracleTool('7z'), ['l', '-slt', '-ba', path.join(FIXTURE_DIR, 'zeros-20mib.cab')], { encoding: 'utf8' });
      expect(listing).toMatch(/^Path = zeros-20mib\.bin$/m);
      expect(listing).toMatch(/^Size = 20971520$/m);
      const expected = sha256(Buffer.alloc(20 * MIB));
      for (const target of TARGETS) {
        const result = await dispatchConversion(cab, 'cab', target, {}, 'zeros-20mib.cab');
        const output = await readArchiveTree(result.buffer, target);
        expect(fileDigests(output.files), target).toEqual({ 'zeros-20mib.bin': expected });
      }
    },
    ENGINE_TIMEOUT_MS
  );
});

describe('the ratio floor on every path', () => {
  oracleTest(
    'a 7z of zeros converts at 32 MiB and is refused as a ratio bomb at 33 MiB, to a tar and to a zip',
    ['7z', 'python3'],
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-floor-7z-'));
      try {
        const atFloor = fs.readFileSync(build7zZeroBomb(path.join(dir, 'at.7z'), path.join(dir, 'stage-at'), FLOOR_MIB));
        const past = fs.readFileSync(build7zZeroBomb(path.join(dir, 'past.7z'), path.join(dir, 'stage-past'), FLOOR_MIB + 1));
        expect(atFloor.length * 100).toBeLessThan(FLOOR_MIB * MIB);
        for (const target of ['tar', 'zip'] as const) {
          const converted = await dispatchConversion(atFloor, '7z', target, {}, 'at.7z');
          const output = await readArchiveTree(converted.buffer, target);
          expect(fileDigests(output.files), target).toEqual({ 'zeros.bin': sha256(Buffer.alloc(FLOOR_MIB * MIB)) });
          expect(await refusal(dispatchConversion(past, '7z', target, {}, 'past.7z')), target).toMatchObject({
            name: 'UnsafeArchiveError',
            reason: 'compression-ratio',
          });
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ENGINE_TIMEOUT_MS
  );

  oracleTest(
    'a gzip of zeros converts at 32 MiB and is refused as a ratio bomb at 33 MiB',
    ['7z', 'tar'],
    async () => {
      const atFloor = zlib.gzipSync(Buffer.alloc(FLOOR_MIB * MIB), { level: 9 });
      const past = zlib.gzipSync(Buffer.alloc((FLOOR_MIB + 1) * MIB), { level: 9 });
      expect(atFloor.length * 100).toBeLessThan(FLOOR_MIB * MIB);
      const converted = await dispatchConversion(atFloor, 'gz', 'zip', {}, 'zeros.gz');
      const output = await readArchiveTree(converted.buffer, 'zip');
      expect([...output.files.values()].map(sha256)).toEqual([sha256(Buffer.alloc(FLOOR_MIB * MIB))]);
      expect(await refusal(dispatchConversion(past, 'gz', 'zip', {}, 'zeros.gz'))).toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'compression-ratio',
      });
    },
    ENGINE_TIMEOUT_MS
  );

  for (const [tool, source] of [
    ['bzip2', 'bz2'],
    ['xz', 'xz'],
  ] as const) {
    oracleTest(
      `a ${tool} file of zeros converts at 32 MiB and is refused as a ratio bomb at 33 MiB`,
      [tool, '7z', 'tar'],
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ratio-floor-${tool}-`));
        try {
          const pack = (mib: number): Buffer => {
            const file = path.join(dir, `zeros${mib}`);
            fs.writeFileSync(file, Buffer.alloc(mib * MIB));
            execFileSync(requireOracleTool(tool), ['-9', '-k', file]);
            return fs.readFileSync(`${file}.${source}`);
          };
          const converted = await dispatchConversion(pack(FLOOR_MIB), source, 'zip', {}, `zeros.${source}`);
          const output = await readArchiveTree(converted.buffer, 'zip');
          expect([...output.files.values()].map(sha256)).toEqual([sha256(Buffer.alloc(FLOOR_MIB * MIB))]);
          expect(await refusal(dispatchConversion(pack(FLOOR_MIB + 1), source, 'zip', {}, `zeros.${source}`))).toMatchObject({
            message: expect.stringMatching(/compression ratio/),
          });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      ENGINE_TIMEOUT_MS
    );
  }
});
