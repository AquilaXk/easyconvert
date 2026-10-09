import { describe, expect, it } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { expectNoSlowerThanReference } from './helpers/timing';
import { generateMusicStereo, generateSpeechMono } from './helpers/flac-reference';

/**
 * Timing-ratio checks moved out of flac-encoder-compression.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

const RATE = 44100;
// Regression ceiling, not a benchmark. The reference unit is ten plain passes over the samples (a sum of squares):
// a pass takes about a millisecond for speech, too short to time alone. The encoder costs 3.5 to 4.6 units on a
// quiet machine and the encoder it replaced (2.8 MB/s against about 17 MB/s) 21 to 27, so the bound of 15 keeps
// headroom for shared CI runners while a fall back to the old path fails.
const MAX_ENCODE_COST_PER_REFERENCE_UNIT = 15;
const REFERENCE_PASSES = 10;
const THROUGHPUT_RUNS = 5;
const FLAC_MAGIC = 'fLaC';

/** The reference unit of work the encoder's cost is expressed in: REFERENCE_PASSES plain passes over the samples. */
function referenceUnit(pcm: Int16Array): number {
  let sum = 0;
  for (let pass = 0; pass < REFERENCE_PASSES; pass++) {
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  }
  return sum;
}
const TEST_TIMEOUT_MS = 120_000;

interface Signal {
  name: string;
  channels: number;
  make: () => Int16Array;
}

const SIGNALS: ReadonlyArray<Signal> = [
  { name: 'stereo music', channels: 2, make: generateMusicStereo },
  { name: 'mono speech', channels: 1, make: generateSpeechMono },
];

describe('FLAC encoder speed against plain passes over the samples', () => {
  for (const signal of SIGNALS) {
    it(
      `${signal.name}: encodes within ${MAX_ENCODE_COST_PER_REFERENCE_UNIT}x the cost of ten scalar passes over the PCM`,
      async () => {
        // Speed is judged against this machine, not a fixed MB/s: the encoder is timed against plain passes over
        // the same samples, interleaved and best of N (tests/helpers/timing.ts); see the constants above.
        const pcm = signal.make();
        const { largeResult: stream } = await expectNoSlowerThanReference(
          `${signal.name} FLAC encode`,
          () => referenceUnit(pcm),
          () => encodeFlacStream(pcm, RATE, signal.channels),
          { maxRatio: MAX_ENCODE_COST_PER_REFERENCE_UNIT, passes: THROUGHPUT_RUNS }
        );
        expect(stream.subarray(0, FLAC_MAGIC.length).toString('latin1')).toBe(FLAC_MAGIC);
      },
      TEST_TIMEOUT_MS
    );
  }
});
