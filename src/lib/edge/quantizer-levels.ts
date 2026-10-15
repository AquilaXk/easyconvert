/**
 * Per-channel levels for a colour budget, shared by every edge path that quantises (the Wasm worker and the
 * WebGPU path), so all of them keep at most the same number of colours.
 */

import { EdgeUnsupportedError } from './workers/worker-errors';

/** Fewest colours uniform levels can describe: two levels in each of three channels. */
const MIN_QUANTIZE_COLORS = 8;
const MAX_CHANNEL_LEVELS = 256;
/** Largest ratio between the finest and the coarsest channel of the levels derived for a colour count. */
const MAX_LEVEL_RATIO = 2;
const MIN_CHANNEL_LEVELS = 2;

export interface QuantizerLevels {
  r: number;
  g: number;
  b: number;
}

/**
 * The per-channel level counts that keep at most `maxColors` colours: the largest product of three counts
 * (each 2..256, the finest at most twice the coarsest) that does not exceed `maxColors`, the finest going to
 * green and the coarsest to blue, as the eye resolves them. 256 colours give 8 x 8 x 4 levels, 64 give 4 x 4 x 4.
 */
export function deriveQuantizerLevels(maxColors: number): QuantizerLevels {
  if (!Number.isInteger(maxColors) || maxColors < MIN_QUANTIZE_COLORS) {
    throw new EdgeUnsupportedError(
      `The edge quantiser keeps whole numbers of colours from ${MIN_QUANTIZE_COLORS} up (colors ${maxColors}); the server engine builds smaller palettes.`
    );
  }
  // More colours than three full channels hold change nothing; the cap also bounds the search below.
  const allowance = Math.min(maxColors, MAX_CHANNEL_LEVELS ** 3);
  let best = { product: 0, spread: 0, levels: [MIN_CHANNEL_LEVELS, MIN_CHANNEL_LEVELS, MIN_CHANNEL_LEVELS] };
  for (let coarse = MIN_CHANNEL_LEVELS; coarse * coarse * coarse <= allowance; coarse++) {
    for (let middle = coarse; middle * middle * coarse <= allowance; middle++) {
      const fine = Math.min(MAX_CHANNEL_LEVELS, MAX_LEVEL_RATIO * coarse, Math.floor(allowance / (middle * coarse)));
      if (fine < middle) continue;
      const product = fine * middle * coarse;
      const spread = fine - coarse;
      if (product > best.product || (product === best.product && spread < best.spread)) {
        best = { product, spread, levels: [fine, middle, coarse] };
      }
    }
  }
  const [fine, middle, coarse] = best.levels;
  return { g: fine, r: middle, b: coarse };
}

