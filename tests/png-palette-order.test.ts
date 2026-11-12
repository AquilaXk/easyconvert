import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { coOccurrenceOrder, edgeColourFirst, renumberIndices } from '../src/lib/conversions/png-palette-order';

/**
 * The palette order of an indexed PNG. The properties are the ones the order is chosen for: it is a permutation, colours that are neighbours
 * in the picture end up neighbours in the palette, the colour that covers the picture comes first, and renumbering keeps every pixel's colour.
 */

/** A deterministic shuffle of 0..n-1 (the palette order the quantiser might have written). */
function shuffled(n: number, seed: number): number[] {
  const values = Array.from({ length: n }, (_, i) => i);
  let state = seed;
  for (let i = n - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const j = (state >>> 8) % (i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

/** A picture whose colour changes smoothly along x (a ramp of `colours` steps, `step` pixels each), with the colour numbers `palette[step]`. */
function ramp(width: number, height: number, colours: number, palette: number[]): Buffer {
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) out[y * width + x] = palette[Math.min(colours - 1, Math.floor((x * colours) / width))];
  }
  return out;
}

const roughness = (indices: Uint8Array, width: number): number => {
  let sum = 0;
  for (let i = 1; i < indices.length; i += 1) if (i % width !== 0) sum += Math.abs(indices[i] - indices[i - 1]);
  return sum;
};

describe('coOccurrenceOrder', () => {
  it('is a permutation of the palette', () => {
    const indices = ramp(120, 10, 30, shuffled(30, 5));
    const order = coOccurrenceOrder(indices, 120, 10, 30);
    expect(order).not.toBeNull();
    expect(Array.from(order ?? []).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('puts the colours of a ramp in a row, so that neighbouring pixels have neighbouring indices', () => {
    const palette = shuffled(40, 11);
    const indices = ramp(200, 12, 40, palette);
    const order = coOccurrenceOrder(indices, 200, 12, 40) ?? new Uint8Array();
    const renumbered = renumberIndices(indices, order);
    // Every step of the ramp is one index away from the next, whichever end the order starts from.
    for (let step = 1; step < 40; step += 1) {
      const before = Array.from(order).indexOf(palette[step - 1]);
      const after = Array.from(order).indexOf(palette[step]);
      expect(Math.abs(before - after)).toBe(1);
    }
    expect(roughness(renumbered, 200)).toBeLessThan(roughness(indices, 200));
  });

  it('puts the colour that covers at least 15 percent of the picture first', () => {
    const width = 100;
    const indices = Buffer.alloc(width * 20, 9);
    for (let i = 0; i < indices.length; i += 1) if (i % 3 === 0) indices[i] = (i * 7) % 24;
    const order = coOccurrenceOrder(indices, width, 20, 24) ?? new Uint8Array();
    expect(order[0]).toBe(9);
  });

  it('keeps colours that no pixel uses (they go anywhere, and the order is still a permutation)', () => {
    const indices = ramp(90, 4, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const order = coOccurrenceOrder(indices, 90, 4, 14) ?? new Uint8Array();
    expect(Array.from(order).sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i));
  });

  it('is the same on every run', () => {
    const indices = ramp(150, 9, 33, shuffled(33, 3));
    expect(Array.from(coOccurrenceOrder(indices, 150, 9, 33) ?? [])).toEqual(Array.from(coOccurrenceOrder(indices, 150, 9, 33) ?? []));
  });

  /** A random walk over the palette, `smooth` indices at most a step: a picture whose neighbours are usually near in index, as a ramp is. */
  function walk(seed: number, length: number, colours: number, smooth: number): Buffer {
    const out = Buffer.alloc(length);
    let state = seed;
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      value = Math.max(0, Math.min(colours - 1, value + (((state >>> 16) % (2 * smooth + 1)) - smooth)));
      out[i] = value;
    }
    return out;
  }

  // The digests are those of the first version of the port, which followed oxipng's cost loops step by step (every insertion position tried
  // against every placed colour); the version that keeps the sums of weights to the left and right of each colour must write the same order.
  it.each([
    [1, 120, 90, 256, 3, '11ed0407c7e487b7'],
    [2, 200, 50, 100, 1, '03d09d7b814b1f1a'],
    [3, 64, 64, 40, 2, '1036e28437aed53b'],
    [4, 300, 10, 17, 1, null],
    [5, 77, 131, 200, 6, 'aa5521fb702df514'],
  ])('writes the order of the step-by-step version for walk %i (%i x %i, %i colours, step %i)', (seed, width, height, colours, step, digest) => {
    const order = coOccurrenceOrder(walk(seed, width * height, colours, step), width, height, colours);
    expect(order === null ? null : crypto.createHash('sha256').update(order).digest('hex').slice(0, 16)).toBe(digest);
  });

  it.each([
    ['two colours', Buffer.from([0, 1, 0, 1, 1, 0]), 3, 2, 2],
    ['an indices array that is not width times height', Buffer.alloc(10), 3, 3, 20],
    ['more colours than a palette holds', Buffer.alloc(9), 3, 3, 300],
    ['colours that never meet', Buffer.alloc(0), 0, 0, 5],
  ])('gives no order for %s', (_name, indices, width, height, colours) => {
    expect(coOccurrenceOrder(indices, width, height, colours)).toBeNull();
  });
});

describe('renumberIndices', () => {
  it('gives every pixel the new number of its colour, and leaves the input as it is', () => {
    const indices = Buffer.from([0, 1, 2, 3, 2, 1]);
    const copy = Buffer.from(indices);
    const order = Uint8Array.from([2, 0, 3, 1]);
    // order[new] = old: old 2 is new 0, old 0 is new 1, old 3 is new 2, old 1 is new 3.
    expect(Array.from(renumberIndices(indices, order))).toEqual([1, 3, 0, 2, 0, 3]);
    expect(indices.equals(copy)).toBe(true);
  });
});

describe('edgeColourFirst', () => {
  it('swaps the colour that starts and ends the rows with index 0', () => {
    // 4 x 3: the rows start and end with colour 5, which is also the most common colour on the edges.
    const indices = Buffer.from([5, 1, 2, 5, 5, 2, 0, 5, 5, 3, 3, 5]);
    const order = edgeColourFirst(indices, 4, 3, 8);
    expect(Array.from(order ?? [])).toEqual([5, 1, 2, 3, 4, 0, 6, 7]);
  });

  it('gives no order when index 0 is already the edge colour, or when two colours tie', () => {
    expect(edgeColourFirst(Buffer.from([0, 1, 2, 0, 0, 3, 3, 0]), 4, 2, 4)).toBeNull();
    expect(edgeColourFirst(Buffer.from([1, 0, 0, 2]), 4, 1, 3)).toBeNull();
  });

  it('gives no order for a picture of one colour, no pixels, or the wrong number of indices', () => {
    expect(edgeColourFirst(Buffer.from([0, 0]), 2, 1, 1)).toBeNull();
    expect(edgeColourFirst(Buffer.alloc(0), 0, 0, 3)).toBeNull();
    expect(edgeColourFirst(Buffer.alloc(5), 2, 2, 3)).toBeNull();
  });
});
