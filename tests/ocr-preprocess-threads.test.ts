import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { baseImageThreads, imageThreadsFor, memoryLimitBytes } from '../src/lib/conversions/image-threads';
import { OCR_PREPROCESS_STEPS, preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';

/**
 * The page preparation (decode, enlarge, turn) is image-library work, and the library runs on one thread unless a
 * caller leases more (image-threads.ts). The enlargement of the benchmark scan takes 30 ms on one thread and 22 ms
 * on two, so the preparation leases the threads and puts the base count back when it ends.
 */

const SCAN = path.join(__dirname, '..', 'bench', 'corpus', 'scan.png');

/** The highest thread count the library reports while `work` runs, sampled between the event loop's turns. */
async function peakThreadsDuring<T>(work: () => Promise<T>): Promise<{ peak: number; result: T }> {
  let peak = sharp.concurrency();
  let running = true;
  const sampler = (async () => {
    while (running) {
      peak = Math.max(peak, sharp.concurrency());
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  try {
    const result = await work();
    peak = Math.max(peak, sharp.concurrency());
    return { peak, result };
  } finally {
    running = false;
    await sampler;
  }
}

describe('page preparation threads', () => {
  const leased = imageThreadsFor(os.availableParallelism(), memoryLimitBytes());

  it('runs the preparation on the leased threads and restores the base count afterwards', async () => {
    sharp.concurrency(baseImageThreads());
    const scan = fs.readFileSync(SCAN);
    const { peak, result } = await peakThreadsDuring(() => preprocessOcrImage(scan, { ...OCR_PREPROCESS_STEPS, binarize: false }));
    expect(result.applied.rescale).toBe(true);
    expect(peak).toBe(leased);
    expect(sharp.concurrency()).toBe(baseImageThreads());
  });

  it('puts the base count back when the page cannot be prepared', async () => {
    sharp.concurrency(baseImageThreads());
    await expect(preprocessOcrImage(Buffer.from('not an image'))).rejects.toThrow();
    expect(sharp.concurrency()).toBe(baseImageThreads());
  });
});
