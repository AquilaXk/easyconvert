import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasTarHeaderChecksum } from '../src/lib/conversions/archive-extraction-safety';
import { convertWithNative7z } from '../src/worker/engines';
import { zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * A compression wrapper that unpacks to one file is vetted as a tar only when that file can be one. The check is the
 * tar header checksum, the same test 7-Zip applies before it lists a file as a tar. Tar headers are made by the system
 * `tar` in every format it writes; the number of 7-Zip processes a conversion starts is counted by a wrapper script that
 * logs each call and then runs the real 7-Zip, so the count comes from outside the code under test.
 */
const TOOLS = ['7z', 'tar', 'xz', 'unshare'] as const;
const TEST_TIMEOUT_MS = 120_000;
/**
 * One `7z x -so` call unpacks the stream. A payload that is a tar is listed in process, and one that is not is
 * wrapped in process, so neither starts a second 7-Zip.
 */
const SPAWNS_FOR_ANY_PAYLOAD = 1;
/** Text that compresses about four to one, well under the archive ratio guard. */
const PAYLOAD_BYTES = 200_000;
const TAR_FORMATS = ['v7', 'ustar', 'gnu', 'pax'] as const;

let workDir = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-tar-vetting-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function tarFile(name: string, format: string, entries: ReadonlyArray<{ name: string; data?: string; target?: string }>): string {
  const sourceDir = fs.mkdtempSync(path.join(workDir, 'src-'));
  for (const entry of entries) {
    if (entry.target !== undefined) fs.symlinkSync(entry.target, path.join(sourceDir, entry.name));
    else fs.writeFileSync(path.join(sourceDir, entry.name), entry.data ?? '');
  }
  const file = path.join(workDir, name);
  execFileSync('tar', [`--format=${format}`, '-cf', file, '-C', sourceDir, ...entries.map((e) => e.name)]);
  return file;
}

describe('tar header checksum test', () => {
  oracleTest(
    'accepts a header the system tar writes in every format, including v7 with no ustar magic',
    ['tar'],
    () => {
      for (const format of TAR_FORMATS) {
        const file = tarFile(`ok-${format}.tar`, format, [{ name: 'a.txt', data: 'alpha' }]);
        expect(hasTarHeaderChecksum(file), format).toBe(true);
      }
    }
  );

  it('rejects files that are not a tar header', () => {
    const noise = path.join(workDir, 'noise.bin');
    fs.writeFileSync(noise, Buffer.alloc(2048, 0x7e));
    const text = path.join(workDir, 'text.txt');
    fs.writeFileSync(text, 'just some text\n'.repeat(100));
    const zeros = path.join(workDir, 'zeros.bin');
    fs.writeFileSync(zeros, Buffer.alloc(2048));
    const short = path.join(workDir, 'short.bin');
    fs.writeFileSync(short, Buffer.alloc(100, 0x20));
    const empty = path.join(workDir, 'empty.bin');
    fs.writeFileSync(empty, '');
    const outcomes = new Map<string, boolean>([
      ['noise', hasTarHeaderChecksum(noise)],
      ['text', hasTarHeaderChecksum(text)],
      ['zeros', hasTarHeaderChecksum(zeros)],
      ['short', hasTarHeaderChecksum(short)],
      ['empty', hasTarHeaderChecksum(empty)],
      ['missing', hasTarHeaderChecksum(path.join(workDir, 'missing.bin'))],
    ]);
    expect([...outcomes.entries()].filter(([, accepted]) => accepted).map(([name]) => name)).toEqual([]);
  });

  oracleTest(
    'rejects a tar header with one byte changed',
    ['tar'],
    () => {
      const file = tarFile('tampered.tar', 'ustar', [{ name: 'a.txt', data: 'alpha' }]);
      const bytes = fs.readFileSync(file);
      expect(hasTarHeaderChecksum(file)).toBe(true);
      bytes[0] ^= 0x01;
      fs.writeFileSync(file, bytes);
      expect(hasTarHeaderChecksum(file)).toBe(false);
    }
  );
});

describe('conversion of a compressed payload to tar', () => {
  /** A wrapper that appends a line to a log for every call and then runs the real 7-Zip with the same arguments. */
  function countingSevenZip(): { script: string; log: string } {
    const real = getOracleToolPath('7z');
    if (real === null) throw new Error('7z is required');
    const log = path.join(workDir, 'calls.log');
    const script = path.join(workDir, 'counting-7z.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho call >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    return { script, log };
  }

  async function countSpawns(source: Buffer, filename: string): Promise<{ calls: number; output: Buffer }> {
    const { script, log } = countingSevenZip();
    fs.rmSync(log, { force: true });
    const previous = process.env.P7ZIP_PATH;
    process.env.P7ZIP_PATH = script;
    try {
      const result = await convertWithNative7z(source, 'xz', 'tar', {}, filename);
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line === 'call').length : 0;
      return { calls, output: result.buffer };
    } finally {
      if (previous === undefined) delete process.env.P7ZIP_PATH;
      else process.env.P7ZIP_PATH = previous;
    }
  }

  oracleTest(
    'starts one 7-Zip process for a payload that is not a tar, and the tar it writes holds the payload',
    [...TOOLS],
    async () => {
      const payload = zipfText(PAYLOAD_BYTES, 31);
      const xz = execFileSync('xz', ['-6', '-c'], { input: payload });
      const { calls, output } = await countSpawns(xz, 'payload.xz');
      expect(calls).toBe(SPAWNS_FOR_ANY_PAYLOAD);
      const file = path.join(workDir, 'out-plain.tar');
      fs.writeFileSync(file, output);
      const listed = execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).trim().split('\n');
      expect(listed).toHaveLength(1);
      expect(execFileSync('tar', ['-xOf', file, listed[0]]).equals(payload)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'vets a payload that is a tar in process and returns it unchanged, in every tar format',
    [...TOOLS],
    async () => {
      for (const format of TAR_FORMATS) {
        const tar = fs.readFileSync(tarFile(`wrapped-${format}.tar`, format, [{ name: 'a.txt', data: 'alpha' }]));
        const xz = execFileSync('xz', ['-6', '-c'], { input: tar });
        const { calls, output } = await countSpawns(xz, `wrapped-${format}.tar.xz`);
        expect(calls, format).toBe(SPAWNS_FOR_ANY_PAYLOAD);
        expect(output.equals(tar), format).toBe(true);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'still rejects a symlink inside a v7 tar that has no ustar magic',
    [...TOOLS],
    async () => {
      const tar = fs.readFileSync(
        tarFile('v7-link.tar', 'v7', [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', target: '/etc' },
        ])
      );
      expect(tar.toString('latin1', 257, 262)).not.toBe('ustar');
      const xz = execFileSync('xz', ['-6', '-c'], { input: tar });
      await expect(convertWithNative7z(xz, 'xz', 'tar', {}, 'v7-link.tar.xz')).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
    },
    TEST_TIMEOUT_MS
  );
});
