import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { measureQuantizeCost } from './helpers/quantize-cost';
import { skipUnless } from './helpers/strict-skip';

/**
 * Timing check moved out of palette-quantizer-quality.test.ts: the CPU time of the quantizer at 1.92 megapixels is an absolute
 * figure that depends on the speed of the core, so it is checked in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate, which keeps the memory the run adds.
 * It reads 0.31 to 0.35 s on the Linux test VM (policy entry 112).
 */
const PERF_MAX_CPU_SECONDS = 1.5;
const HAS_PROC = process.platform === 'linux';

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'palette-cost-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(SKIP_WITHOUT_MAGICK || skipUnless('Linux /proc (VmHWM)', HAS_PROC))('cost at 1.92 megapixels and 256 colours', () => {
  it('takes at most 1.5 s of CPU time', async () => {
    const measured = await measureQuantizeCost(workDir);
    expect(measured.bestCpuMs / 1000).toBeLessThanOrEqual(PERF_MAX_CPU_SECONDS);
  }, 180_000);
});
