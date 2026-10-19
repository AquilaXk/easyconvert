import fs from 'node:fs';
import { ensureSample, remoteSample } from '../../bench/corpora';
import { isStrictMode } from './strict-skip';

/**
 * A public sample of the benchmark corpus (bench/corpus/remote-manifest.json) that a test reads. It is never committed:
 * `ensureSample` fetches it from the host that publishes it and checks the pinned size and SHA-256, so every run reads the
 * same bytes. Where it cannot be fetched a run that is not strict skips the test; under ORACLE_STRICT_MODE=1 it fails, so
 * CI cannot pass without having read the file.
 */

/** What the test context offers: `skip` ends the test as skipped. */
interface SkippableContext {
  skip: () => never;
}

export async function requireBenchSample(ctx: SkippableContext, id: string): Promise<Buffer> {
  const sample = remoteSample(id);
  if (sample === undefined) throw new Error(`no sample ${id} in the benchmark manifest`);
  try {
    return fs.readFileSync(await ensureSample(sample));
  } catch (error) {
    if (isStrictMode()) throw error;
    return ctx.skip();
  }
}
