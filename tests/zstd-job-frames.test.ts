import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compressZstd, compressZstdAsync, decompressZstd, planZstdJobs, ZSTD_POOL_MIN_LEVEL } from '../src/lib/conversions/zstd';
import { ZSTD_BLOCK_SIZE_MAX } from '../src/lib/conversions/zstd-tables';
import { CpuPoolOverloadedError, CpuTaskAbortedError, EngineUnavailableError } from '../src/lib/types';
import { getCpuPool, shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { SeededRandom, jsonRecords, runBytes, sourceText, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * A level below ZSTD_POOL_MIN_LEVEL splits an input of more than two blocks into jobs that are encoded independently
 * (each with the tail of the data before it as history) and joined into one frame, so the pool threads and the
 * calling thread can work on one input together. The frame must be what the layout alone determines: the same bytes
 * whether the jobs run one after the other or on pool threads, readable by the reference decoder, and not larger
 * than the reference encoder's frame at the same level.
 */
const TEST_TIMEOUT_MS = 300_000;
const MEGABYTE = 1024 * 1024;
const JOB_LEVELS = [1, 3, 6, 9] as const;
const JOB_INPUT_BYTES = 900_000;

afterAll(async () => {
  await shutdownCpuPool();
});

/** The benchmark's mixed input: its JSON records, then its PCM audio. */
function benchmarkMixedInput(): Buffer {
  const corpus = path.resolve(__dirname, '..', 'bench', 'corpus');
  return Buffer.concat([fs.readFileSync(path.join(corpus, 'data', 'records.jsonl')), fs.readFileSync(path.join(corpus, 'speech.wav'))]);
}

/** JSON records, then low-compressibility bytes, as in the benchmark's mixed input. */
function mixedInput(): Buffer {
  return Buffer.concat([jsonRecords(650_000, 71), new SeededRandom(72).bytes(JOB_INPUT_BYTES - 650_000)]);
}

const INPUTS: ReadonlyArray<[string, () => Buffer]> = [
  ['TypeScript-like source', () => sourceText(JOB_INPUT_BYTES, 61)],
  ['English-like prose', () => zipfText(JOB_INPUT_BYTES, 62)],
  ['JSON records then noise', mixedInput],
  ['long runs', () => runBytes(JOB_INPUT_BYTES, 63)],
];

describe('planZstdJobs', () => {
  it('leaves an input of at most two blocks, and any input at a high level, as one frame of one job', () => {
    expect(planZstdJobs(2 * ZSTD_BLOCK_SIZE_MAX, 3)).toBeNull();
    expect(planZstdJobs(0, 3)).toBeNull();
    expect(planZstdJobs(4 * MEGABYTE, ZSTD_POOL_MIN_LEVEL)).toBeNull();
    expect(planZstdJobs(4 * MEGABYTE, 19)).toBeNull();
  });

  it('covers the input with block-aligned jobs whose history never reaches before the data', () => {
    for (const length of [2 * ZSTD_BLOCK_SIZE_MAX + 1, JOB_INPUT_BYTES, 3 * MEGABYTE + 17, 40 * MEGABYTE]) {
      const jobs = planZstdJobs(length, 3);
      expect(jobs, `length ${length}`).not.toBeNull();
      let next = 0;
      for (const job of jobs!) {
        expect(job.from).toBe(next);
        expect(job.from % ZSTD_BLOCK_SIZE_MAX).toBe(0);
        expect(job.to).toBeGreaterThan(job.from);
        expect(job.historyFrom).toBeGreaterThanOrEqual(0);
        expect(job.historyFrom).toBeLessThanOrEqual(job.from);
        next = job.to;
      }
      expect(next).toBe(length);
    }
  });

  it('gives a 900 KB input at least three jobs so that the pool threads and the caller all have work', () => {
    expect(planZstdJobs(JOB_INPUT_BYTES, 3)!.length).toBeGreaterThanOrEqual(3);
  });

  it('depends on the length and the level only', () => {
    expect(planZstdJobs(JOB_INPUT_BYTES, 3)).toEqual(planZstdJobs(JOB_INPUT_BYTES, 3));
  });
});

describe.each(INPUTS)('frames of jobs: %s', (_name, build) => {
  const input = build();

  it.each(JOB_LEVELS)('level %i: the pool path returns the bytes of the in-thread path, and our decoder restores the input', async (level) => {
    expect(planZstdJobs(input.length, level)).not.toBeNull();
    const inThread = compressZstd(input, { level });
    const viaPool = await compressZstdAsync(input, { level });
    expect(viaPool.equals(inThread)).toBe(true);
    expect(decompressZstd(inThread).equals(input)).toBe(true);
  }, TEST_TIMEOUT_MS);

  oracleTest('the zstd command line tests and restores the frame of every job level', ['zstd'], () => {
    const zstd = getOracleToolPath('zstd')!;
    for (const level of JOB_LEVELS) {
      const frame = compressZstd(input, { level });
      execFileSync(zstd, ['-t', '-q'], { input: frame });
      const restored = execFileSync(zstd, ['-d', '-q', '-c'], { input: frame, maxBuffer: 1 << 26 });
      expect(restored.equals(input), `level ${level}`).toBe(true);
    }
  });
});

describe('ratio of the frame of jobs', () => {
  oracleTest('is no larger than the reference encoder frame at level 3 on JSON records and on the benchmark mixed input', ['zstd'], () => {
    const zstd = getOracleToolPath('zstd')!;
    const cases: Array<[string, Buffer]> = [
      ['json', jsonRecords(JOB_INPUT_BYTES, 64)],
      ['benchmark mixed input', benchmarkMixedInput()],
    ];
    for (const [name, data] of cases) {
      const reference = execFileSync(zstd, ['-3', '-q', '-c'], { input: data, maxBuffer: 1 << 26 }).length;
      expect(compressZstd(data, { level: 3 }).length, name).toBeLessThanOrEqual(reference);
    }
  });
});

describe('a pool that cannot take a job', () => {
  it.each([
    ['has no thread entry on this deployment', () => new EngineUnavailableError('cpu-pool', 'no cpu-worker bundle')],
    ['has a full queue', () => new CpuPoolOverloadedError(64, 64)],
  ])('still returns the frame of the in-thread jobs when it %s', async (_name, failure) => {
    const input = sourceText(JOB_INPUT_BYTES, 65);
    const refused = vi.spyOn(getCpuPool(), 'submit').mockRejectedValue(failure());
    try {
      const frame = await compressZstdAsync(input, { level: 3 });
      expect(refused).toHaveBeenCalled();
      expect(frame.equals(compressZstd(input, { level: 3 }))).toBe(true);
      expect(decompressZstd(frame).equals(input)).toBe(true);
    } finally {
      refused.mockRestore();
    }
  });

  it('rejects an aborted request with the typed abort error, the jobs not being run', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await compressZstdAsync(sourceText(JOB_INPUT_BYTES, 66), { level: 3, signal: controller.signal }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(CpuTaskAbortedError);
    expect((outcome as Error).message).toBe('The zstd task was cancelled');
  });
});

describe('singleJob', () => {
  it('keeps the whole input as one job: a match across the whole window is found, as the unsplit encoder finds it', () => {
    const block = new SeededRandom(81).bytes(60_000);
    // The same 60 KB twice, 400 KB apart: beyond the one block of history a job reaches back, inside the window.
    const input = Buffer.concat([block, new SeededRandom(82).bytes(340_000), block, new SeededRandom(83).bytes(10_000)]);
    const single = compressZstd(input, { level: 3, singleJob: true });
    const jobs = compressZstd(input, { level: 3 });
    expect(planZstdJobs(input.length, 3)).not.toBeNull();
    expect(single.length).toBeLessThan(input.length - 50_000);
    expect(jobs.length).toBeGreaterThan(single.length + 50_000);
    expect(decompressZstd(single).equals(input)).toBe(true);
    expect(decompressZstd(jobs).equals(input)).toBe(true);
  });
});
