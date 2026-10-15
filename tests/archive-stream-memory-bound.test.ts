import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { hostileTarEnd, hostileTarMember, pythonTarEntries, pythonTarMember } from './helpers/hostile-tar';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * The streaming routes hold the unpacked bytes in memory. They do so only while that fits the in-process budget
 * (`MAX_IN_MEMORY_BYTES`) and only when the request does not ask for zero heap; otherwise the request is served by
 * the general pipeline, which works on disk. What reached 7-Zip is read from the recording wrapper: a streaming call
 * writes to a pipe (`-so`), the disk pipeline extracts into a directory (`-o`).
 */
const TOOLS = ['7z', 'xz', 'tar', 'python3'] as const;
const TEST_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
const SMALL_BUDGET_BYTES = MIB;
/** Text that compresses about four to one: over the budget when unpacked, far under the 100:1 ratio guard. */
const PAYLOAD_BYTES = 3 * MIB;

let workDir = '';
let spy: SevenZipSpy;
let previousBudget: string | undefined;

function seven(args: string[], cwd: string): void {
  execFileSync(getOracleToolPath('7z') as string, args, { cwd, stdio: 'ignore' });
}

function streamsToPipe(call: string[]): boolean {
  return call[0] === 'x' && call.includes('-so');
}

function extractsToDirectory(call: string[]): boolean {
  return call[0] === 'x' && call.some((argument) => argument.startsWith('-o'));
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-memory-bound-'));
  spy = createSevenZipSpy(workDir);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  spy.reset();
  spy.install();
  previousBudget = process.env.MAX_IN_MEMORY_BYTES;
});

afterEach(() => {
  spy.restore();
  if (previousBudget === undefined) delete process.env.MAX_IN_MEMORY_BYTES;
  else process.env.MAX_IN_MEMORY_BYTES = previousBudget;
});

describe('output that does not fit the in-memory budget is served from disk', () => {
  oracleTest(
    'xz to tar: a payload that unpacks past the budget is converted by the disk pipeline, with its bytes',
    [...TOOLS],
    async () => {
      const payload = zipfText(PAYLOAD_BYTES, 51);
      const tar = Buffer.concat([hostileTarMember({ name: 'big.txt' }, payload), hostileTarEnd()]);
      const xz = execFileSync('xz', ['-6', '-c'], { input: tar });
      process.env.MAX_IN_MEMORY_BYTES = String(SMALL_BUDGET_BYTES);

      const result = await convertWithNative7z(xz, 'tar.xz', 'tar', {}, 'big.tar.xz');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');

      // The disk pipeline carries the unpacked bytes; how it names the members is its own business.
      expect(result.buffer.includes(payload)).toBe(true);
      expect(spy.calls().some(extractsToDirectory)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    '7z to tar: members that add up to more than the budget are converted by the disk pipeline, with their bytes',
    [...TOOLS],
    async () => {
      const payload = zipfText(PAYLOAD_BYTES, 52);
      const stage = path.join(workDir, 'seven-stage');
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, 'big.txt'), payload);
      const archive = path.join(workDir, 'big.7z');
      seven(['a', '-t7z', '-y', archive, 'big.txt'], stage);
      process.env.MAX_IN_MEMORY_BYTES = String(SMALL_BUDGET_BYTES);
      // The archive itself is smaller than the budget; only the unpacked size is over it.
      expect(fs.statSync(archive).size).toBeLessThan(SMALL_BUDGET_BYTES);

      const result = await convertWithNative7z(fs.readFileSync(archive), '7z', 'tar', {}, 'big.7z');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');

      expect(pythonTarMember(result.buffer, 'big.txt').equals(payload)).toBe(true);
      expect(spy.calls().some(streamsToPipe)).toBe(false);
      expect(spy.calls().some(extractsToDirectory)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a bomb is still refused with its typed error under a small budget, not handed to the disk pipeline',
    [...TOOLS],
    async () => {
      const bomb = execFileSync('sh', ['-c', 'head -c 400000000 /dev/zero | xz -1 -c'], { maxBuffer: 64 * MIB });
      process.env.MAX_IN_MEMORY_BYTES = String(SMALL_BUDGET_BYTES);
      await expect(convertWithNative7z(bomb, 'xz', 'tar', {}, 'bomb.xz')).rejects.toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'compression-ratio',
      });
    },
    TEST_TIMEOUT_MS
  );
});

describe('a zero-heap request never buffers the unpacked bytes', () => {
  const PAYLOAD = zipfText(100_000, 53);

  function sources(): { label: string; src: string; tgt: string; input: Buffer }[] {
    const stage = path.join(workDir, 'zero-heap-stage');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'a.txt'), PAYLOAD);
    const sevenArchive = path.join(workDir, 'zero-heap.7z');
    seven(['a', '-t7z', '-y', sevenArchive, 'a.txt'], stage);
    const tarPath = path.join(workDir, 'zero-heap.tar');
    execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', stage, 'a.txt'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return [
      { label: 'xz to tar', src: 'tar.xz', tgt: 'tar', input: execFileSync('xz', ['-6', '-c'], { input: fs.readFileSync(tarPath) }) },
      { label: '7z to tar', src: '7z', tgt: 'tar', input: fs.readFileSync(sevenArchive) },
      { label: 'tar to 7z', src: 'tar', tgt: '7z', input: fs.readFileSync(tarPath) },
    ];
  }

  oracleTest(
    'xz to tar, 7z to tar and tar to 7z take the disk pipeline and still produce their archives',
    [...TOOLS],
    async () => {
      for (const { label, src, tgt, input } of sources()) {
        spy.reset();
        const result = await convertWithNative7z(input, src, tgt, { zeroHeap: true }, `zero-heap.${src}`);
        if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
        const calls = spy.calls();
        expect(calls.some(streamsToPipe), `${label}: no pipe`).toBe(false);
        expect(calls.some(extractsToDirectory), `${label}: extracted to disk`).toBe(true);
        const archive = path.join(workDir, `zero-heap-out.${tgt}`);
        fs.writeFileSync(archive, result.buffer ?? fs.readFileSync(result.filePath as string));
        if (src === 'tar.xz') {
          expect(result.buffer.includes(PAYLOAD), label).toBe(true);
          continue;
        }
        const names =
          tgt === 'tar'
            ? pythonTarEntries(fs.readFileSync(archive)).map((entry) => entry.name)
            : execFileSync(getOracleToolPath('7z') as string, ['l', '-slt', '-ba', archive], { encoding: 'utf8' })
                .split('\n')
                .filter((line) => line.startsWith('Path = '))
                .map((line) => line.slice('Path = '.length));
        expect(names, label).toEqual(['a.txt']);
      }
    },
    TEST_TIMEOUT_MS
  );
});
