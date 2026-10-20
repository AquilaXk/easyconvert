import { setFlagsFromString } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { runPdfTextJobInThread, shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { warmupPdf } from '../src/lib/conversions/pdf-text-warmup';

/**
 * The old-generation threshold of the text threads (128 MB, against the default V8 computes from the heap limit) must stay with
 * the text threads. The flag is process-wide, so the host sets it only from before a text thread is made until that thread is
 * online. The probe is a thread of another module's kind (same heap limit, no flag): it builds about 50 MB of live objects and
 * counts its full collections, which are 2 with the default threshold and 0 with the 128 MB one.
 */

const PROBE = `
const { parentPort } = require('node:worker_threads');
const { PerformanceObserver, constants } = require('node:perf_hooks');
let fullCollections = 0;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) fullCollections++;
}).observe({ entryTypes: ['gc'] });
const live = [];
for (let chunk = 0; chunk < 20; chunk++) {
  const objects = [];
  for (let index = 0; index < 40000; index++) objects.push({ chunk, index, label: 'x' + index });
  live.push(objects);
  new Array(20000).fill(0).map((_, k) => ({ k }));
}
setTimeout(() => parentPort.postMessage(fullCollections), 50);
`;
const HEAP_LIMIT_MB = 1024;
const YOUNG_LIMIT_MB = 64;
const DEFAULT_FULL_COLLECTIONS = 2;
const THRESHOLD_FULL_COLLECTIONS = 0;
const TEXT_JOB = { geometry: 'none', content: true } as const;

/** Full collections of a probe thread started now, with the process flag as it is. */
function probeFullCollections(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Worker(PROBE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB, maxYoungGenerationSizeMb: YOUNG_LIMIT_MB } });
    probe.once('message', (count: number) => {
      void probe.terminate();
      resolve(count);
    });
    probe.once('error', reject);
  });
}

afterAll(() => {
  shutdownPdfTextThreads();
});

describe('the old-generation threshold of the text threads', () => {
  it('tells the probe apart: a thread made with the flag set collects less than one made without it', async () => {
    expect(await probeFullCollections()).toBe(DEFAULT_FULL_COLLECTIONS);
    setFlagsFromString('--initial-old-space-size=128');
    try {
      expect(await probeFullCollections()).toBe(THRESHOLD_FULL_COLLECTIONS);
    } finally {
      setFlagsFromString('--initial-old-space-size=0');
    }
  });

  it('is in effect for a thread made while a text thread is starting', async () => {
    const reading = runPdfTextJobInThread(Buffer.from(warmupPdf()), TEXT_JOB);
    const during = probeFullCollections();
    await reading;
    expect(await during).toBe(THRESHOLD_FULL_COLLECTIONS);
  });

  it('is gone for threads of other modules made after the text thread is online', async () => {
    await runPdfTextJobInThread(Buffer.from(warmupPdf()), TEXT_JOB);
    expect(await probeFullCollections()).toBe(DEFAULT_FULL_COLLECTIONS);
    expect(await probeFullCollections()).toBe(DEFAULT_FULL_COLLECTIONS);
  });
});
