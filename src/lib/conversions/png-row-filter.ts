/**
 * The rows of an 8-bit indexed PNG with a filter chosen for each row by its Shannon entropy: each of the five PNG filters is tried on the
 * row and the one whose bytes have the lowest entropy is written, behind its filter byte. A filter that predicts a pixel from its neighbours
 * leaves small differences where the palette puts similar colours at similar indices (see `png-palette-order.ts`), and the deflater codes
 * small, repeated differences in fewer bits than the indices themselves.
 *
 * The method is the `Entropy` strategy of oxipng 10.2.1 (`src/filters/strategies.rs` and `mod.rs`; oxipng/oxipng, MIT, Copyright (c) 2016
 * Joshua Holmer), which has it from LodePNG (Lode Vandevenne, zlib licence): the score of a row is the sum over byte values of `n * log2(n)`
 * (`ilog2i`, the integer approximation oxipng uses), the highest score is the lowest entropy, a tie keeps the earlier filter in the order none,
 * sub, up, average, Paeth, and a row of zeros stays unfiltered. The filter byte is counted in the score, as oxipng counts it. For an 8-bit
 * palette picture the filters work on one byte per pixel.
 */

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
const FILTERS = 5;
const BYTE_VALUES = 256;

/** `i * log2(i)` to an integer: the floor of the logarithm times `i`, plus the linear interpolation of the rest (oxipng's `ilog2i`). */
function scoreOf(count: number): number {
  const log = 31 - Math.clz32(count);
  return count * log + ((count - (1 << log)) << 1);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** `indices` (one byte a pixel, row after row) as scanlines of `1 + width` bytes: the filter byte, then the filtered row. */
export function filterRowsByEntropy(indices: Uint8Array, width: number, height: number): Buffer {
  const rowBytes = width + 1;
  const out = Buffer.alloc(rowBytes * height);
  const candidates = Array.from({ length: FILTERS }, () => new Uint8Array(width));
  const histograms = new Uint32Array(FILTERS * BYTE_VALUES);
  const zeros = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    const row = indices.subarray(y * width, (y + 1) * width);
    const above = y === 0 ? zeros : indices.subarray((y - 1) * width, y * width);
    const target = y * rowBytes;
    let allZero = true;
    histograms.fill(0);
    for (let x = 0; x < width; x += 1) {
      const value = row[x];
      const left = x > 0 ? row[x - 1] : 0;
      const up = above[x];
      const upLeft = x > 0 ? above[x - 1] : 0;
      if (value !== 0) allZero = false;
      candidates[FILTER_NONE][x] = value;
      candidates[FILTER_SUB][x] = (value - left) & 0xff;
      candidates[FILTER_UP][x] = (value - up) & 0xff;
      candidates[FILTER_AVERAGE][x] = (value - ((left + up) >> 1)) & 0xff;
      candidates[FILTER_PAETH][x] = (value - paeth(left, up, upLeft)) & 0xff;
    }
    if (allZero) continue;
    let best = FILTER_NONE;
    let bestScore = -1;
    for (let filter = 0; filter < FILTERS; filter += 1) {
      const histogram = filter * BYTE_VALUES;
      const bytes = candidates[filter];
      for (let x = 0; x < width; x += 1) histograms[histogram + bytes[x]] += 1;
      histograms[histogram + filter] += 1;
      let score = 0;
      for (let value = 0; value < BYTE_VALUES; value += 1) {
        const count = histograms[histogram + value];
        if (count !== 0) score += scoreOf(count);
      }
      if (score > bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    out[target] = best;
    out.set(candidates[best], target + 1);
  }
  return out;
}
