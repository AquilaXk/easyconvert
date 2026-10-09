import { describe, it } from 'vitest';
import { parseCgmToSvg } from '../src/lib/conversions/vector-cad';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of cgm-source-redos.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in cgm-source-redos.test.ts.
 */

const REPS = 300_000;
/** A CGM states its canvas size; one without a VDC extent is refused. */
const EXTENT = 'VDCEXT (0,0) (100,100); ';

describe('CGM clear-text parsing stays linear on adversarial input', () => {
  it('handles repeated POLYGON keywords without a terminator in linear time', async () => {
    // Growth, not wall-clock: a quarter of the repetitions takes about a quarter of the time (tests/helpers/timing.ts).
    const cgm = (n: number) => `BEGMF ${EXTENT}${'POLYGON '.repeat(n)}`;
    await expectLinearOnInputs('POLYGON keywords', (input: string) => parseCgmToSvg(input), {
      small: cgm(REPS),
      large: cgm(REPS * SCALING_FACTOR),
    });
  }, SCALING_TEST_TIMEOUT_MS);

  it('handles repeated TEXT heads without a quoted string in linear time', async () => {
    const cgm = (n: number) => `BEGMF ${EXTENT}${'TEXT (1,1)'.repeat(n)}`;
    await expectLinearOnInputs('TEXT heads', (input: string) => parseCgmToSvg(input), {
      small: cgm(REPS),
      large: cgm(REPS * SCALING_FACTOR),
    });
  }, SCALING_TEST_TIMEOUT_MS);
});
