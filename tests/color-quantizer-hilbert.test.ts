import { describe, expect, it } from 'vitest';
import { riemersmaDither, walkHilbertCurve } from '../src/lib/conversions/color-quantizer';
import { expectNoHang } from './helpers/timing';

/**
 * The Riemersma dither walks the picture along a Hilbert curve. The walk visits the cells of a width x height picture and no
 * others, in the order of the Hilbert curve of the power-of-two square that holds it with the cells outside left out, so a
 * 65,535 x 1 picture costs 65,535 steps, not the 4.3 billion of its 65,536 x 65,536 square.
 */

/** Hilbert curve coordinates of index d on an n x n grid (n a power of two): Wikipedia, "Hilbert curve", function d2xy. */
function d2xy(n: number, d: number): [number, number] {
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

/** The order the walk had when it stepped the whole square and skipped the cells outside the picture. */
function paddedOrder(width: number, height: number): Array<[number, number]> {
  let side = 1;
  while (side < Math.max(width, height)) side *= 2;
  const order: Array<[number, number]> = [];
  for (let d = 0; d < side * side; d += 1) {
    const [x, y] = d2xy(side, d);
    if (x < width && y < height) order.push([x, y]);
  }
  return order;
}

function walked(width: number, height: number): Array<[number, number]> {
  const order: Array<[number, number]> = [];
  walkHilbertCurve(width, height, (x, y) => order.push([x, y]));
  return order;
}

describe('walkHilbertCurve', () => {
  const sizes: Array<[number, number]> = [[1, 1], [2, 2], [3, 5], [5, 3], [17, 1], [1, 17], [64, 64], [100, 37], [37, 100], [129, 130]];

  it.each(sizes)('visits the cells of a %i x %i picture in the order of the padded Hilbert curve', (width, height) => {
    expect(walked(width, height)).toEqual(paddedOrder(width, height));
  });

  it('visits each cell of a 1,000 x 999 picture once', () => {
    const seen = new Uint8Array(1_000 * 999);
    let count = 0;
    walkHilbertCurve(1_000, 999, (x, y) => {
      seen[y * 1_000 + x] += 1;
      count += 1;
    });
    expect(count).toBe(999_000);
    expect(seen.every((times) => times === 1)).toBe(true);
  });

  it('takes steps in proportion to the cells of a 16,000,000 x 1 picture, not to its 2^48 square', () => {
    let count = 0;
    let last = -1;
    walkHilbertCurve(16_000_000, 1, (x) => {
      count += 1;
      last = x;
    });
    expect(count).toBe(16_000_000);
    expect(last).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('visits nothing for an empty picture', () => {
    expect(walked(0, 5)).toEqual([]);
    expect(walked(5, 0)).toEqual([]);
  });
});

describe('Riemersma dither of a thin picture', () => {
  it('finishes a 65,535 x 1 picture in the time of its pixels', async () => {
    const width = 65_535;
    const pixels = new Uint8Array(width * 4);
    for (let x = 0; x < width; x += 1) pixels.set([x & 255, (x >> 3) & 255, 128, 255], x * 4);
    const palette = [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 0, b: 255 },
    ];
    // 10 ms on a fast core; the 4.3 billion steps of the square of its longer side took about 80 s.
    const result = await expectNoHang('Riemersma dither of 65,535 x 1', () => riemersmaDither(pixels, width, 1, palette));
    expect(result.indexed.length).toBe(width);
    expect(Math.max(...result.indexed.slice(0, 1000))).toBeLessThan(palette.length);
  }, 120_000);
});
