import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressZstd, decompressZstd, getZstdBinaryPath } from '../src/lib/conversions/zstd';
import { oracleTest } from './helpers/oracle-test';
import {
  MIB,
  englishLikeText,
  jsonRecords,
  longRuns,
  makeRng,
  noiseBytes,
  periodic,
  twoSymbolRandom,
  typescriptSourceCorpus,
} from './helpers/zstd-corpora';
import lazyLevelHashes from './fixtures/zstd/lazy-levels-1-15.sha256.json';

/**
 * Optimal parsing (levels 16-19) against the zstd CLI as an independent oracle.
 *
 * Ratio and integrity are judged by the reference binary (`zstd -t`, `zstd -d`, `zstd -N` sizes);
 * the byte-identity goldens for levels 1-15 are SHA-256 digests of the output of the encoder as it
 * was before optimal parsing existed (generated once from the parent commit, never from this code).
 */

const OPTIMAL_LEVELS = [16, 17, 18, 19];
const LAZY_LEVELS = Array.from({ length: 15 }, (_, i) => i + 1);
/** Acceptance bound from the optimal-parse brief: within 2% of the reference size. */
const MAX_SIZE_FACTOR_VS_CLI = 1.02;
/** Level 19 aims at 1 MB/s on 1 MiB inputs; the assertion allows 4x slack for loaded CI machines. */
const LEVEL19_TIME_BUDGET_MS_PER_MIB = 4000;
/** Adversarial inputs must finish in bounded time; far above the observed cost, far below a hang. */
const ADVERSARIAL_TIME_BUDGET_MS = 30_000;
const TEST_TIMEOUT_MS = 240_000;
const GOLDEN_INPUT_BYTES = 160 * 1024;
/** Level 16 must beat level 15 (the best hash-chain level) by at least this factor, proving the tree parser runs. */
const MIN_GAIN_OVER_LEVEL_15 = 0.97;
/** Adjacent optimal levels differ by a few hundredths of a percent on some corpora; allow that much noise. */
const MONOTONE_SLACK = 1.005;
const FUZZ_CASES = 24;
const FUZZ_SEED = 20240497;
const FUZZ_LENGTH_MAX = 200 * 1024;
const FUZZ_SHORT_LENGTH_MAX = 300;
const FUZZ_SHORT_SHARE = 0.3;
const FUZZ_GENERATOR_COUNT = 6;
const MAX_CLI_BUFFER = 256 * MIB;

const SOURCE_ROOT = path.resolve(__dirname, '..');

function zstdBinary(): string {
  const bin = getZstdBinaryPath();
  if (!bin) throw new Error('zstd CLI path unavailable although the oracle precondition passed.');
  return bin;
}

function cliCompress(input: Buffer, level: number): Buffer {
  return execFileSync(zstdBinary(), [`-${level}`, '-c', '-q', '-T1'], { input, maxBuffer: MAX_CLI_BUFFER });
}

function cliDecompress(frame: Buffer): Buffer {
  return execFileSync(zstdBinary(), ['-d', '-c', '-q'], { input: frame, maxBuffer: MAX_CLI_BUFFER });
}

function cliTestPasses(frame: Buffer): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-optimal-'));
  const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.zst`);
  try {
    fs.writeFileSync(file, frame);
    execFileSync(zstdBinary(), ['-t', '-q', file], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function timed<T>(action: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = action();
  return { value, ms: performance.now() - start };
}

function assertValidFrame(label: string, frame: Buffer, input: Buffer): void {
  expect(cliTestPasses(frame), `${label}: zstd -t`).toBe(true);
  const viaCli = cliDecompress(frame);
  expect(viaCli.length, `${label}: zstd -d length`).toBe(input.length);
  expect(Buffer.compare(viaCli, input), `${label}: zstd -d bytes`).toBe(0);
  const viaOurs = decompressZstd(frame);
  expect(viaOurs.length, `${label}: own decoder length`).toBe(input.length);
  expect(Buffer.compare(viaOurs, input), `${label}: own decoder bytes`).toBe(0);
}

function realCorpora(): Array<[string, Buffer]> {
  return [
    ['english', englishLikeText(MIB, 500, 52)],
    ['typescript', typescriptSourceCorpus(SOURCE_ROOT, MIB)],
    ['json', jsonRecords(MIB, 51)],
  ];
}

function adversarialCorpora(): Array<[string, Buffer]> {
  return [
    ['two-symbol random', twoSymbolRandom(MIB, 7)],
    ['long runs', longRuns(MIB, 8)],
    ['periodic', periodic(MIB, 97, 9)],
    ['uniform noise', noiseBytes(MIB / 4, 10)],
  ];
}

describe('levels 1-15 stay byte-identical', () => {
  const inputs: Array<[string, Buffer]> = [
    ['json', jsonRecords(GOLDEN_INPUT_BYTES, 101)],
    ['english', englishLikeText(GOLDEN_INPUT_BYTES, 800, 102)],
    ['periodic', periodic(GOLDEN_INPUT_BYTES, 211, 103)],
    ['twosym', twoSymbolRandom(GOLDEN_INPUT_BYTES, 104)],
    ['runs', longRuns(GOLDEN_INPUT_BYTES, 105)],
    ['noise', noiseBytes(GOLDEN_INPUT_BYTES, 106)],
  ];
  const goldens = lazyLevelHashes as Record<string, string>;

  it('pins one digest per corpus and level', () => {
    expect(Object.keys(goldens)).toHaveLength(inputs.length * LAZY_LEVELS.length);
    for (const digest of Object.values(goldens)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  for (const [name, input] of inputs) {
    it(`${name}: every level 1-15 reproduces the pre-optimal-parse output`, () => {
      for (const level of LAZY_LEVELS) {
        const digest = crypto.createHash('sha256').update(compressZstd(input, { level })).digest('hex');
        expect(digest, `${name} level ${level}`).toBe(goldens[`${name}:${level}`]);
      }
    });
  }
});

describe('optimal parsing at levels 16-19', () => {
  oracleTest(
    'ratio stays within 2% of the CLI on English, TypeScript and JSON, and every frame validates',
    ['zstd'],
    () => {
      for (const [name, input] of realCorpora()) {
        for (const level of OPTIMAL_LEVELS) {
          const ours = compressZstd(input, { level });
          assertValidFrame(`${name} level ${level}`, ours, input);
          const reference = cliCompress(input, level);
          expect(
            ours.length / reference.length,
            `${name} level ${level}: ${ours.length} B vs CLI ${reference.length} B`
          ).toBeLessThanOrEqual(MAX_SIZE_FACTOR_VS_CLI);
        }
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'level 16 is at least 3% smaller than level 15 on every corpus, as the CLI is',
    ['zstd'],
    () => {
      for (const [name, input] of realCorpora()) {
        const lazy = compressZstd(input, { level: 15 }).length;
        const optimal = compressZstd(input, { level: 16 }).length;
        const cliLazy = cliCompress(input, 15).length;
        const cliOptimal = cliCompress(input, 16).length;
        expect(cliOptimal / cliLazy, `${name}: CLI 16 vs 15 shows the gain is real`).toBeLessThan(1);
        expect(optimal / lazy, `${name}: ${optimal} B vs ${lazy} B`).toBeLessThanOrEqual(MIN_GAIN_OVER_LEVEL_15);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a higher optimal level does not emit a larger frame, and level 19 beats level 16',
    ['zstd'],
    () => {
      for (const [name, input] of realCorpora()) {
        const sizes = OPTIMAL_LEVELS.map((level) => compressZstd(input, { level }).length);
        for (let i = 1; i < sizes.length; i++) {
          expect(sizes[i], `${name}: level ${OPTIMAL_LEVELS[i]} vs ${OPTIMAL_LEVELS[i - 1]}`).toBeLessThanOrEqual(
            sizes[i - 1] * MONOTONE_SLACK
          );
        }
        expect(sizes[sizes.length - 1], `${name}: level 19 vs level 16`).toBeLessThan(sizes[0]);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'level 19 compresses 1 MiB of English, TypeScript and JSON within the throughput budget',
    ['zstd'],
    () => {
      for (const [name, input] of realCorpora()) {
        const { value: frame, ms } = timed(() => compressZstd(input, { level: 19 }));
        assertValidFrame(`${name} level 19`, frame, input);
        expect(ms, `${name}: ${ms.toFixed(0)} ms`).toBeLessThanOrEqual(LEVEL19_TIME_BUDGET_MS_PER_MIB);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'adversarial inputs finish in bounded time, validate, and stay within 2% of the CLI at level 19',
    ['zstd'],
    () => {
      for (const [name, input] of adversarialCorpora()) {
        const { value: frame, ms } = timed(() => compressZstd(input, { level: 19 }));
        expect(ms, `${name}: ${ms.toFixed(0)} ms`).toBeLessThanOrEqual(ADVERSARIAL_TIME_BUDGET_MS);
        assertValidFrame(`${name} level 19`, frame, input);
        const reference = cliCompress(input, 19);
        expect(frame.length / reference.length, `${name}: ${frame.length} B vs CLI ${reference.length} B`).toBeLessThanOrEqual(
          MAX_SIZE_FACTOR_VS_CLI
        );
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'inputs around block and window edges round-trip through the CLI at every optimal level',
    ['zstd'],
    () => {
      const sizes = [0, 1, 2, 3, 4, 7, 8, 9, 127, 1000, 131071, 131072, 131073, 262144 + 5];
      const source = englishLikeText(300 * 1024, 300, 61);
      for (const size of sizes) {
        const input = source.subarray(0, size);
        for (const level of OPTIMAL_LEVELS) {
          assertValidFrame(`size ${size} level ${level}`, compressZstd(input, { level }), input);
        }
      }
    },
    TEST_TIMEOUT_MS
  );
});

function fuzzInput(rng: () => number): Buffer {
  const pick = (n: number): number => Math.floor(rng() * n);
  const length = rng() < FUZZ_SHORT_SHARE ? pick(FUZZ_SHORT_LENGTH_MAX) : pick(FUZZ_LENGTH_MAX);
  const seed = pick(1 << 30) + 1;
  switch (pick(FUZZ_GENERATOR_COUNT)) {
    case 0:
      return noiseBytes(length, seed);
    case 1:
      return englishLikeText(length, 50 + pick(2000), seed);
    case 2:
      return jsonRecords(length, seed);
    case 3:
      return twoSymbolRandom(length, seed);
    case 4:
      return longRuns(length, seed);
    default:
      return periodic(length, 1 + pick(5000), seed);
  }
}

describe('optimal parsing fuzz', () => {
  oracleTest(
    'random inputs of mixed structure decode byte-exact through the CLI and the own decoder at levels 16-19',
    ['zstd'],
    () => {
      const rng = makeRng(FUZZ_SEED);
      for (let i = 0; i < FUZZ_CASES; i++) {
        const input = fuzzInput(rng);
        for (const level of OPTIMAL_LEVELS) {
          const frame = compressZstd(input, { level });
          assertValidFrame(`case ${i} level ${level}`, frame, input);
        }
      }
    },
    TEST_TIMEOUT_MS
  );
});
