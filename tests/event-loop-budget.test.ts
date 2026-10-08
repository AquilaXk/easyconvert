import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressBzip2, compressBzip2Async } from '../src/lib/conversions/bzip2';
import { convertFont, decodeSfnt, encodeWoff2 } from '../src/lib/conversions/font';
import { encode16BitPng, encode16BitPngAsync } from '../src/lib/conversions/png16';
import { EVENT_LOOP_BLOCK_BUDGET_MS } from '../src/lib/workers/cpu-pool';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { buildGlyfFont, type GlyfGlyphSpec } from './helpers/glyf-font-builder';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { SeededRandom } from './helpers/archive-corpus';

/**
 * No single conversion may hold the event loop longer than EVENT_LOOP_BLOCK_BUDGET_MS: health checks, progress updates and
 * uploads share that loop. Each case runs the production entry point while `monitorEventLoopDelay` records how late the
 * loop's timer fires; the largest delay is the longest stretch the loop was blocked. A control case measures the
 * synchronous encoder, to show that the monitor sees a blocked loop.
 */
const SAMPLE_INTERVAL_MS = 5;
const NS_PER_MS = 1e6;
const TEST_TIMEOUT_MS = 600_000;
const BYTES_PER_MB = 1024 * 1024;

interface LoopStats {
  maxMs: number;
}

async function withLoopMonitor<T>(work: () => Promise<T>): Promise<{ value: T } & LoopStats> {
  const histogram = monitorEventLoopDelay({ resolution: SAMPLE_INTERVAL_MS });
  histogram.enable();
  try {
    // The first timer tick after enabling only sets the baseline: a stretch blocked before it would go unrecorded.
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS * 3));
    const value = await work();
    // Let a final timer tick land so that the last stretch of work is accounted for.
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS * 2));
    return { value, maxMs: histogram.max / NS_PER_MS };
  } finally {
    histogram.disable();
  }
}

/** The histogram counts the sampling interval itself, so a loop that is never blocked still reads about one interval. */
const BUDGET_MS = EVENT_LOOP_BLOCK_BUDGET_MS + SAMPLE_INTERVAL_MS;

afterAll(async () => {
  await shutdownCpuPool();
});

function randomGlyphs(count: number, seed: number): GlyfGlyphSpec[] {
  const rng = new SeededRandom(seed);
  return Array.from({ length: count }, (_, i) => ({
    codePoint: 0x4e00 + i,
    advance: 800 + rng.below(200),
    contours: Array.from({ length: 4 }, () => Array.from({ length: 60 }, () => ({ x: rng.below(1000), y: rng.below(1000), on: rng.below(3) !== 0 }))),
  }));
}

describe('event loop stays free during CPU-bound encodes', () => {
  it('the monitor reports a blocked loop for the synchronous bzip2 encoder (control)', async () => {
    const data = Buffer.from(new SeededRandom(5).bytes(2 * BYTES_PER_MB));
    const { maxMs } = await withLoopMonitor(async () => compressBzip2(data));
    expect(maxMs).toBeGreaterThan(BUDGET_MS);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['a 1 MB', 850],
    ['a 3 MB', 2400],
  ])('WOFF2 encode of %s font keeps the loop delay under the budget', async (_label, glyphCount) => {
    const ttf = buildGlyfFont({ family: 'Budget Test', glyphs: randomGlyphs(glyphCount, 3) });
    expect(ttf.length).toBeGreaterThan(BYTES_PER_MB);
    const { value, maxMs } = await withLoopMonitor(() => convertFont(ttf, 'ttf', 'woff2', {}, 'budget.ttf'));
    expect(value.buffer.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(maxMs).toBeLessThan(BUDGET_MS);
    // The same font through the synchronous encoder: the thread must produce the same bytes.
    const sync = encodeWoff2(decodeSfnt(ttf, 'budget'));
    expect(value.buffer.equals(sync)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('a 24 MP 16-bit PNG encode keeps the loop delay under the budget and equals the synchronous encoder', async () => {
    const width = 6000;
    const height = 4000;
    const rgb = new Uint16Array(width * height * 3);
    const rng = new SeededRandom(17);
    for (let y = 0; y < height; y++) {
      const base = (y * 60000) / height;
      for (let x = 0; x < width * 3; x++) rgb[y * width * 3 + x] = base + ((x * 5) % 4000) + rng.below(64);
    }
    const { value, maxMs } = await withLoopMonitor(() => encode16BitPngAsync(width, height, rgb));
    expect(maxMs).toBeLessThan(BUDGET_MS);
    expect(value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    // The pool thread and the calling thread run the same code: compare on a strip that is cheap to encode here.
    const strip = rgb.subarray(0, width * 3 * 64);
    const viaPool = await encode16BitPngAsync(width, 64, strip.slice());
    expect(viaPool.equals(encode16BitPng(width, 64, strip))).toBe(true);
  }, TEST_TIMEOUT_MS);

  oracleTest('a 16 MB bzip2 encode keeps the loop delay under the budget and decodes with `bzip2 -dc`', ['bzip2'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzip2-budget-'));
    const rng = new SeededRandom(23);
    const sources: Buffer[] = [];
    for (let i = 0; i < 16; i++) {
      const chunk = Buffer.alloc(BYTES_PER_MB);
      for (let k = 0; k < chunk.length; k++) chunk[k] = 97 + ((k * 7 + rng.below(6)) % 26);
      sources.push(chunk);
    }
    const data = Buffer.concat(sources);
    const file = path.join(dir, 'input.bin');
    fs.writeFileSync(file, data);
    const { value, maxMs } = await withLoopMonitor(() => compressBzip2Async(data));
    expect(maxMs).toBeLessThan(BUDGET_MS);
    const restored = execFileSync(getOracleToolPath('bzip2')!, ['-dc'], { input: value, maxBuffer: 1 << 28 });
    expect(restored.equals(data)).toBe(true);
    // Joining independently encoded blocks gives the single-threaded stream byte for byte.
    expect(value.equals(compressBzip2(data))).toBe(true);
  }, TEST_TIMEOUT_MS);
});
