import { runUnderDeadline } from '@/lib/api/sync-deadline';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { bindJobLimits } from '@/lib/conversions/job-time';
import type { WorkerConversionResult } from '@/worker/engines';
import { HEALTH_CACHE_TTL_MS } from './probes';
import { memoizeVerdict } from './verdict-memo';

/** A one-pixel red PPM, which ImageMagick decodes in the sandboxed child that every native conversion starts in. */
const SMOKE_PPM = 'P6\n1 1\n255\n\xff\x00\x00';
/** Answers before deploy.sh stops waiting (`curl --max-time 60`), so a slow sandbox is logged as the route's 504. */
export const SMOKE_DEADLINE_MS = 30_000;
/** The conversion belongs to no caller, so a caller that goes away ends only its own wait. */
const NO_CALLER = { signal: new AbortController().signal };

/**
 * The fixed conversion of the deploy's smoke (src/app/api/health/conversion): at most one at a time, and the next no sooner than
 * `HEALTH_CACHE_TTL_MS` after the last verdict, as the readiness probes are held. Callers share the conversion and its outcome,
 * failure included. A conversion that ignores its deadline keeps the place until it ends.
 */
const smokeVerdict = memoizeVerdict<WorkerConversionResult>(HEALTH_CACHE_TTL_MS, () => {
  let dispatched: Promise<WorkerConversionResult> | undefined;
  const verdict = runUnderDeadline(NO_CALLER, SMOKE_DEADLINE_MS, (limits) => {
    dispatched = dispatchConversion(Buffer.from(SMOKE_PPM, 'latin1'), 'ppm', 'png', bindJobLimits({}, limits), 'smoke.ppm');
    return dispatched;
  });
  return { verdict, settled: dispatched };
});

export const smokeConversion = smokeVerdict.get;

/** Forgets the verdict; for tests. */
export const resetSmokeVerdict = smokeVerdict.reset;
