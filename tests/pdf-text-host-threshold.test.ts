import { setFlagsFromString } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { runPdfTextJobInThread, shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { warmupPdf } from '../src/lib/conversions/pdf-text-warmup';

/**
 * The old-generation threshold of the text threads (128 MB, against the default V8 computes from the heap limit) must stay with
 * the text threads. The flag is process-wide, so the host sets it only from before a text thread is made until that thread is
 * online. The probe is a thread of another module's kind (same heap limit, no flag): it builds about 160 MB of live objects and
 * reports how far into that work its first full collection came (0 to 1; 1 when it never collected). With the default threshold
 * that comes early, with 128 MB late or never. The exact counts of collections depend on the host, so the test compares probes
 * with each other: one made with the default, one made with the flag set by hand, and the ones made after a text thread.
 */

const PROBE = `
const { parentPort } = require('node:worker_threads');
const { PerformanceObserver, constants, performance } = require('node:perf_hooks');
const CHUNKS = 64;
let firstFullCollection = Infinity;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) firstFullCollection = Math.min(firstFullCollection, entry.startTime);
  }
}).observe({ entryTypes: ['gc'] });
const live = [];
const builtAt = [];
for (let chunk = 0; chunk < CHUNKS; chunk++) {
  const objects = [];
  for (let index = 0; index < 40000; index++) objects.push({ chunk, index, label: 'x' + index });
  live.push(objects);
  builtAt.push(performance.now());
}
setTimeout(() => parentPort.postMessage(builtAt.filter((at) => at < firstFullCollection).length / CHUNKS), 100);
`;
const HEAP_LIMIT_MB = 1024;
const YOUNG_LIMIT_MB = 64;
const TEXT_JOB = { geometry: 'none', content: true } as const;
/** How much later in the work, as a share of it, the first full collection of a probe with the threshold comes than the default's. */
const MIN_SHARE_LATER = 0.4;

/** How far into its work a probe thread started now reached before its first full collection, with the process flag as it is. */
function probeFirstCollection(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Worker(PROBE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB, maxYoungGenerationSizeMb: YOUNG_LIMIT_MB } });
    probe.once('message', (share: number) => {
      void probe.terminate();
      resolve(share);
    });
    probe.once('error', reject);
  });
}

async function probeWithFlagSet(): Promise<number> {
  setFlagsFromString('--initial-old-space-size=128');
  try {
    return await probeFirstCollection();
  } finally {
    setFlagsFromString('--initial-old-space-size=0');
  }
}

afterAll(() => {
  shutdownPdfTextThreads();
});

describe('the old-generation threshold of the text threads', () => {
  it('tells the probe apart: a thread made with the flag set collects later than one made with the default', async () => {
    const byDefault = await probeFirstCollection();
    const withFlag = await probeWithFlagSet();
    expect(withFlag - byDefault).toBeGreaterThanOrEqual(MIN_SHARE_LATER);
  });

  it('is in effect for a thread made while a text thread is starting', async () => {
    shutdownPdfTextThreads(); // a thread kept from an earlier test would not be started now
    const byDefault = await probeFirstCollection();
    const reading = runPdfTextJobInThread(Buffer.from(warmupPdf()), TEXT_JOB);
    const during = probeFirstCollection();
    await reading;
    expect((await during) - byDefault).toBeGreaterThanOrEqual(MIN_SHARE_LATER);
  });

  it('is gone for threads of other modules made after the text thread is online', async () => {
    const byDefault = await probeFirstCollection();
    const withFlag = await probeWithFlagSet();
    shutdownPdfTextThreads(); // a thread kept from an earlier test would not be started now
    await runPdfTextJobInThread(Buffer.from(warmupPdf()), TEXT_JOB);
    for (const after of [await probeFirstCollection(), await probeFirstCollection()]) {
      // Nearer to the default than to the flagged probe, and well short of the flagged one.
      expect(Math.abs(after - byDefault)).toBeLessThan(Math.abs(after - withFlag));
      expect(withFlag - after).toBeGreaterThanOrEqual(MIN_SHARE_LATER);
    }
  });
});
