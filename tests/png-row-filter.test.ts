import { describe, expect, it } from 'vitest';
import { filterRowsByEntropy } from '../src/lib/conversions/png-row-filter';

/**
 * The entropy filter of the rows of an 8-bit indexed PNG. The oracle is an unfilter written here from the PNG specification (section 9),
 * which shares nothing with the filter: every case must give the indices back.
 */

function unfilter(scanlines: Uint8Array, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    const filter = scanlines[y * (width + 1)];
    for (let x = 0; x < width; x += 1) {
      const raw = scanlines[y * (width + 1) + 1 + x];
      const left = x > 0 ? out[y * width + x - 1] : 0;
      const up = y > 0 ? out[(y - 1) * width + x] : 0;
      const upLeft = x > 0 && y > 0 ? out[(y - 1) * width + x - 1] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`filter ${filter}`);
      out[y * width + x] = (raw + predicted) & 0xff;
    }
  }
  return out;
}

function noise(seed: number, length: number, range: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = (state >>> 16) % range;
  }
  return out;
}

const filtersOf = (scanlines: Uint8Array, width: number, height: number): number[] => Array.from({ length: height }, (_, y) => scanlines[y * (width + 1)]);

describe('filterRowsByEntropy', () => {
  it.each([
    [1, 1],
    [1, 6],
    [9, 1],
    [33, 17],
    [200, 40],
  ])('gives the indices back after the unfilter, for %i x %i pixels of noise, ramps and repeats', (width, height) => {
    const indices = noise(width * 31 + height, width * height, 256);
    for (let y = 1; y < height; y += 3) indices.copy(indices, y * width, (y - 1) * width, y * width);
    for (let x = 0; x < width && height > 1; x += 1) indices[(height - 1) * width + x] = x & 255;
    expect(unfilter(filterRowsByEntropy(indices, width, height), width, height).equals(indices)).toBe(true);
  });

  it('keeps a row of zeros unfiltered', () => {
    expect(filtersOf(filterRowsByEntropy(Buffer.alloc(40), 10, 4), 10, 4)).toEqual([0, 0, 0, 0]);
  });

  it('takes Sub for a ramp, Up for a row that repeats the one above, and None for a row that is as even as it gets', () => {
    const width = 64;
    const ramp = Buffer.from(Array.from({ length: width }, (_, x) => 3 * x));
    const random = noise(5, width, 256);
    const indices = Buffer.concat([ramp, random, random, Buffer.alloc(width, 7)]);
    const filters = filtersOf(filterRowsByEntropy(indices, width, 4), width, 4);
    expect(filters[0]).toBe(1);
    expect(filters[2]).toBe(2);
    expect(filters[3]).toBe(0);
  });

  it('is the same on every run and does not change the indices it is given', () => {
    const indices = noise(8, 60 * 20, 40);
    const copy = Buffer.from(indices);
    const first = filterRowsByEntropy(indices, 60, 20);
    expect(first.equals(filterRowsByEntropy(indices, 60, 20))).toBe(true);
    expect(indices.equals(copy)).toBe(true);
  });
});
