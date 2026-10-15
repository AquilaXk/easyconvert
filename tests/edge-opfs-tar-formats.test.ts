import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, ftruncateSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { failure, runOpfsConversion } from './helpers/opfs-run';
import { craftEntry, craftHeader, END_OF_ARCHIVE } from './helpers/tar-craft';
import { walkTar } from './helpers/tar-walker';

const KIB = 1024;
const MIB = KIB * KIB;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A 16 MiB sparse file with seven data runs, archived by the reference tar in the given format. */
function sparseTar(format: 'gnu' | 'oldgnu' | 'pax'): Buffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sparse-tar-'));
  try {
    const fd = openSync(path.join(dir, 'hole.bin'), 'w');
    // Seven data runs: a GNU sparse header holds four in its own block, so the rest go to an extension block.
    for (let run = 0; run < 7; run++) writeSync(fd, Buffer.alloc(4 * KIB, 0x41 + run), 0, 4 * KIB, run * 2 * MIB);
    ftruncateSync(fd, 16 * MIB);
    closeSync(fd);
    execFileSync(getOracleToolPath('tar') as string, ['--sparse', `--format=${format}`, '-cf', 'out.tar', 'hole.bin'], { cwd: dir });
    return readFileSync(path.join(dir, 'out.tar'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('GNU sparse tar archives go to the server tier, not to a corruption error (issue #480)', () => {
  for (const format of ['gnu', 'oldgnu'] as const) {
    oracleTest(`refuses a ${format} sparse tar in both directions with EdgeUnsupportedError`, ['tar'], async () => {
      const tar = sparseTar(format);
      // The reference tar wrote a sparse entry (typeflag S) that carries its map in extension blocks.
      expect(String.fromCharCode(tar[156])).toBe('S');
      // isextended (offset 482 of the GNU header) says an extension block follows.
      expect(tar[482]).toBe(1);
      for (const [source, target, input] of [
        ['tar', 'tar_gz', tar],
        ['gz', 'tar', gzipSync(tar)],
      ] as const) {
        const error = await failure(runOpfsConversion('sync-access-handle', source, target, input));
        expect(error).toBeInstanceOf(EdgeUnsupportedError);
        expect(error.message).toMatch(/GNU sparse/);
      }
    });
  }

  oracleTest('still converts a pax sparse archive, which stores the map in a pax record and the data as a regular entry', ['tar'], async () => {
    const tar = sparseTar('pax');
    const { bytes } = await runOpfsConversion('sync-access-handle', 'gz', 'tar', gzipSync(tar));
    expect(bytes.equals(tar)).toBe(true);
    expect(walkTar(bytes).map((entry) => entry.typeflag)).toContain('0');
  });

  it('refuses a hand-built sparse header (typeflag S) whose extension block follows', async () => {
    const header = craftHeader({ name: 'sparse.bin', typeflag: 'S', size: 512 });
    const tar = Buffer.concat([header, Buffer.alloc(512, 1), craftEntry('after.txt', 'x'), END_OF_ARCHIVE]);
    const error = await failure(runOpfsConversion('sync-access-handle', 'tar', 'tar_gz', tar));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error).toMatchObject({ message: expect.stringMatching(/GNU sparse/) });
  });
});
