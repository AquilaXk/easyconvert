import { describe, it } from 'vitest';
import sharp from 'sharp';
import { preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of ocr-pnm-pages.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

const TEST_TIMEOUT_MS = 180_000;
/** The PNM hand-over measured about 0.22x the PNG one; re-compressing to PNG would bring it back to 1x. */
const MAX_PNM_HANDOVER_RATIO = 0.6;
const NOISY_PAGE_WIDTH_PX = 2550;
const NOISY_PAGE_HEIGHT_PX = 2000;
const SLOW_RUNNER = process.env.EASYCONVERT_SLOW_RUNNER === '1';

describe('hand-over cost', () => {
  async function noisyColourPage(): Promise<Buffer> {
    const pixels = Buffer.alloc(NOISY_PAGE_WIDTH_PX * NOISY_PAGE_HEIGHT_PX * 3);
    let state = 1;
    for (let i = 0; i < pixels.length; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      pixels[i] = state >>> 24;
    }
    return sharp(pixels, { raw: { width: NOISY_PAGE_WIDTH_PX, height: NOISY_PAGE_HEIGHT_PX, channels: 3 } })
      .png({ compressionLevel: 1 })
      .toBuffer();
  }

  // skip-ok: explicit opt-out on a slow runner (EASYCONVERT_SLOW_RUNNER=1), never set in CI.
  it.skipIf(SLOW_RUNNER)(
    `a noisy 2550x2000 colour page costs at most ${MAX_PNM_HANDOVER_RATIO}x as much to hand over as PNM as it did as PNG`,
    async () => {
      const source = await noisyColourPage();
      // Reference: the step that does not run any more (decode, then compress to PNG for the engine to decode
      // again). Candidate: the PNM hand-over with preprocessing disabled, so only the hand-over differs. Both are
      // timed interleaved in this process, so a loaded runner slows them alike.
      await expectNoSlowerThanReference(
        'PNM hand-over',
        () => sharp(source).rotate().png().toBuffer(),
        () => preprocessOcrImage(source, { rescale: false, deskew: false, binarize: false }),
        { maxRatio: MAX_PNM_HANDOVER_RATIO }
      );
    },
    TEST_TIMEOUT_MS
  );
});
