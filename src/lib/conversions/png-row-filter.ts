/**
 * The rows of an 8-bit indexed PNG with a filter chosen for each row by its Shannon entropy: each of the five PNG filters is tried on the
 * row and the one whose bytes have the lowest entropy is written, behind its filter byte. A filter that predicts a pixel from its neighbours
 * leaves small differences where the palette puts similar colours at similar indices (see `png-palette-order.ts`), and the deflater codes
 * small, repeated differences in fewer bits than the indices themselves.
 *
 * The method is the `Entropy` strategy of oxipng 10.2.1 (https://github.com/oxipng/oxipng, tag `v10.2.1`, commit
 * 36f3ef8aac65ecf1761739ea2f2e530281f1312b, files `src/filters/strategies.rs` and `src/filters/mod.rs`), which takes it from LodePNG (Lode
 * Vandevenne, zlib licence): the score of a row is the sum over byte values of `n * log2(n)` (`ilog2i`, the integer approximation oxipng uses),
 * the highest score is the lowest entropy, a tie keeps the earlier filter in the order none, sub, up, average, Paeth, and a row of zeros stays
 * unfiltered. The filter byte is counted in the score, as oxipng counts it. For an 8-bit palette picture the filters work on one byte a pixel.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2016 Joshua Holmer
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
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
  const histograms = new Uint32Array(FILTERS * BYTE_VALUES);
  const zeros = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    const above = y === 0 ? zeros : indices.subarray(rowStart - width, rowStart);
    const target = y * rowBytes + 1;
    histograms.fill(0);
    let nonZero = 0;
    let left = 0;
    let upLeft = 0;
    for (let x = 0; x < width; x += 1) {
      const value = indices[rowStart + x];
      const up = above[x];
      nonZero |= value;
      histograms[value] += 1;
      histograms[BYTE_VALUES + ((value - left) & 0xff)] += 1;
      histograms[2 * BYTE_VALUES + ((value - up) & 0xff)] += 1;
      histograms[3 * BYTE_VALUES + ((value - ((left + up) >> 1)) & 0xff)] += 1;
      histograms[4 * BYTE_VALUES + ((value - paeth(left, up, upLeft)) & 0xff)] += 1;
      left = value;
      upLeft = up;
    }
    if (nonZero === 0) continue;
    let best = FILTER_NONE;
    let bestScore = -1;
    for (let filter = 0; filter < FILTERS; filter += 1) {
      const histogram = filter * BYTE_VALUES;
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
    out[target - 1] = best;
    writeFiltered(best, indices, rowStart, above, out, target, width);
  }
  return out;
}

/** The bytes of one row under one filter, written to `out` at `target`. */
function writeFiltered(filter: number, indices: Uint8Array, rowStart: number, above: Uint8Array, out: Uint8Array, target: number, width: number): void {
  let left = 0;
  let upLeft = 0;
  for (let x = 0; x < width; x += 1) {
    const value = indices[rowStart + x];
    const up = above[x];
    let predicted = 0;
    if (filter === FILTER_SUB) predicted = left;
    else if (filter === FILTER_UP) predicted = up;
    else if (filter === FILTER_AVERAGE) predicted = (left + up) >> 1;
    else if (filter === FILTER_PAETH) predicted = paeth(left, up, upLeft);
    out[target + x] = (value - predicted) & 0xff;
    left = value;
    upLeft = up;
  }
}
