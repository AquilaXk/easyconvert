import { describe, expect, it } from 'vitest';
import { expectSizeIndependentOnInputs, settle } from './helpers/timing';
import { BmpDecodeError, decodeBmp } from '../src/lib/conversions/bmp';
import { craftBmp } from './helpers/bmp-craft';

/**
 * Timing-ratio checks moved out of bmp-ico-decode.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in bmp-ico-decode.test.ts.
 */

/** Sides of the two canvases an RLE stream of four bytes claims. */
const RLE_MODEST_SIDE = 1000;
const RLE_HUGE_SIDE = 10000;

describe('BMP validation rejects bad files with a typed error before allocating', () => {
  const palette256 = Array.from({ length: 256 }, (_, i) => [i, i, i] as const);

  it('refuses an RLE stream in the same time whatever canvas it declares', async () => {
    // A reader that walked the declared canvas before checking the stream would take a hundred times as long for the
    // 10000 x 10000 claim as for the 1000 x 1000 one (tests/helpers/timing.ts); the check reads only the stream.
    const rleClaiming = (side: number) =>
      craftBmp({ width: side, height: side, bitCount: 8, compression: 1, palette: palette256, pixels: Uint8Array.from([0, 1]) });
    const { largeResult } = await expectSizeIndependentOnInputs('RLE canvas claim', (bytes: Buffer) => settle(() => decodeBmp(bytes)), {
      modest: rleClaiming(RLE_MODEST_SIDE),
      huge: rleClaiming(RLE_HUGE_SIDE),
    });
    if (largeResult.ok) throw new Error('the 10000 x 10000 claim was decoded instead of refused');
    expect(largeResult.error).toBeInstanceOf(BmpDecodeError);
    expect((largeResult.error as Error).message).toMatch(/cannot describe/);
  });
});
