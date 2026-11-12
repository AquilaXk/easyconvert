import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { canSpoolStdout } from '../src/lib/security/process-sandbox';
import { sandboxLauncherState, SANDBOX_LAUNCHER_ENV, startSandboxLauncher, stopSandboxLauncher } from '../src/lib/security/sandbox-launcher';
import { jsonRecords, runBytes, zipfText } from './helpers/archive-corpus';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * A single-stream xz or bzip2 file turned into a tar is decoded by 7-Zip, started from the launcher helper with its output, and for an
 * upload held in memory its input, in files of the worker. The tar that comes out is the one a direct start produces, byte for byte,
 * for a payload that is a tar and for one that is not, and a damaged stream is refused with the same error. The helper's count of
 * programs it started shows which route ran.
 */
const MIB = 1024 * 1024;
const TEST_TIMEOUT_MS = 120_000;
const FIXED_MTIME = '202103040506';
const toolsMissing = skipWithoutTools('7z', 'tar', 'xz', 'bzip2');
const HAS_SPOOL = canSpoolStdout({ spoolStdout: true, maxBuffer: MIB });

const STREAMS = [
  { source: 'xz', compress: (input: Buffer): Buffer => execFileSync('xz', ['-6', '-c'], { input, maxBuffer: 64 * MIB }) },
  { source: 'bz2', compress: (input: Buffer): Buffer => execFileSync('bzip2', ['-9', '-c'], { input, maxBuffer: 64 * MIB }) },
] as const;

let workDir = '';
let tarPayload: Buffer;
const plainPayload = Buffer.concat([zipfText(120_000, 31), runBytes(20_000, 32)]);

/** A ustar archive of three members made by the system tar, with fixed times, so that its rewrite is the same on every run. */
function buildSampleTar(): Buffer {
  const tree = path.join(workDir, 'tree');
  fs.mkdirSync(path.join(tree, 'docs'), { recursive: true });
  const members: Array<[string, Buffer]> = [['docs/a.txt', zipfText(80_000, 21)], ['docs/records.jsonl', jsonRecords(30_000, 22)], ['blob.bin', runBytes(50_000, 23)]];
  for (const [name, data] of members) {
    fs.writeFileSync(path.join(tree, name), data);
    execFileSync('touch', ['-t', FIXED_MTIME, path.join(tree, name)]);
  }
  const tarPath = path.join(workDir, 'sample.tar');
  execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', tree, 'docs', 'blob.bin'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(tarPath);
}

/** The member names of a tar, as the system tar lists them. */
function tarNames(tar: Buffer): string[] {
  const file = path.join(workDir, 'listed.tar');
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
}

/** The conversion with the helper (`launched` programs counted) or with the launcher turned off. */
async function convert(stream: Buffer, source: string, helper: boolean): Promise<{ tar: Buffer; launched: number } | { error: Error }> {
  if (helper) delete process.env[SANDBOX_LAUNCHER_ENV];
  else process.env[SANDBOX_LAUNCHER_ENV] = 'off';
  const before = sandboxLauncherState().launched;
  try {
    const result = await dispatchConversion(stream, source, 'tar', {}, `sample.${source}`);
    return { tar: Buffer.from(result.buffer), launched: sandboxLauncherState().launched - before };
  } catch (error) {
    return { error: error as Error };
  } finally {
    delete process.env[SANDBOX_LAUNCHER_ENV];
  }
}

describe.skipIf(toolsMissing || skipUnless('Linux with prlimit, which bounds a spooled output', HAS_SPOOL))('single-stream archives to tar through the launcher helper', () => {
  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-stream-launcher-'));
    tarPayload = buildSampleTar();
    // A worker's size, so that the helper is judged worth it whatever this test process holds.
    vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(1024 * MIB);
    expect(await startSandboxLauncher()).toBe(true);
  }, 60_000);

  afterAll(() => {
    vi.restoreAllMocks();
    stopSandboxLauncher();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  for (const { source, compress } of STREAMS) {
    it(`writes the same tar for a .${source} of a tar and of a plain file, with 7-Zip started by the helper`, async () => {
      for (const payload of [tarPayload, plainPayload]) {
        const stream = compress(payload);
        const viaHelper = await convert(stream, source, true);
        const direct = await convert(stream, source, false);
        if ('error' in viaHelper || 'error' in direct) throw new Error('the conversion failed');
        expect(viaHelper.launched).toBe(1);
        expect(direct.launched).toBe(0);
        expect(viaHelper.tar.equals(direct.tar)).toBe(true);
        // The system tar reads what was written: the members of a tar payload, or the one member of a plain file.
        expect(tarNames(viaHelper.tar)).toEqual(payload === tarPayload ? ['blob.bin', 'docs/', 'docs/a.txt', 'docs/records.jsonl'] : [`sample.${source}`.replace(/\.(xz|bz2)$/, '')]);
      }
    }, TEST_TIMEOUT_MS);

    it(`refuses a damaged .${source} with the error of a direct start`, async () => {
      const stream = compress(tarPayload);
      const damaged = Buffer.concat([stream.subarray(0, stream.length >> 1), Buffer.alloc(64, 0x5a), stream.subarray((stream.length >> 1) + 64)]);
      const viaHelper = await convert(damaged, source, true);
      const direct = await convert(damaged, source, false);
      if (!('error' in viaHelper) || !('error' in direct)) throw new Error('a damaged stream was not refused');
      expect(viaHelper.error.constructor).toBe(direct.error.constructor);
      expect(viaHelper.error.message).toBe(direct.error.message);
    }, TEST_TIMEOUT_MS);
  }
});
