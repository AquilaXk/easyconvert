import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapToPalette } from '../src/lib/conversions/color-quantizer';
import { COLOUR_MEMO_LAB_STRIDE, ColourMemo } from '../src/lib/conversions/image-colour-memo';
import { KdTree3 } from '../src/lib/conversions/kd-tree';

/**
 * The colour memo of the palette mapper against independent oracles: a `Map` for the table, and for the mapping a
 * full scan of the palette in Oklab computed here from Ottosson's published matrices and the IEC 61966-2-1 transfer
 * function (not by the code under test).
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const INITIAL_SLOT_BITS = 16;
const INITIAL_ENTRIES = 1 << (INITIAL_SLOT_BITS - 1);
const slotOf = (key: number, bits: number): number => Math.imul(key, 0x9e3779b1) >>> (32 - bits);

describe('colour memo', () => {
  it.each([
    [1, 8],
    [3, 8],
    [5, 8],
    [100, 128],
    [5000, 8192],
    [100_000, 32_768],
    [Infinity, 32_768],
  ])('starts a raster of %i pixels with room for %i entries, half of its table', (expected, capacity) => {
    expect(new ColourMemo(false, expected).capacity).toBe(capacity);
  });

  it('never starts with room for more entries than its limit', () => {
    expect(new ColourMemo(false, Infinity, 20).capacity).toBe(20);
    expect(new ColourMemo(false, 5000, 20).capacity).toBe(20);
  });

  it('finds nothing before an add and the entry it numbered after', () => {
    const memo = new ColourMemo(true);
    expect(memo.find(0x123456)).toBe(-1);
    const entry = memo.add(0x123456, 77, 0.5, 0.1, 0.2, 0.3);
    expect(memo.find(0x123456)).toBe(entry);
    expect(memo.index[entry]).toBe(77);
    const at = entry * COLOUR_MEMO_LAB_STRIDE;
    expect(Array.from(memo.lab.subarray(at, at + COLOUR_MEMO_LAB_STRIDE))).toEqual([0.5, 0.1, 0.2, 0.3]);
    expect(memo.find(0x123457)).toBe(-1);
  });

  it('numbers entries in the order they were added', () => {
    const memo = new ColourMemo(false);
    expect([memo.add(5, 1, 0, 0, 0, 0), memo.add(9, 2, 0, 0, 0, 0), memo.add(0, 3, 0, 0, 0, 0)]).toEqual([0, 1, 2]);
    expect(memo.count).toBe(3);
  });

  it('keeps no Oklab fields when asked for none', () => {
    const memo = new ColourMemo(false);
    memo.add(1, 1, 9, 9, 9, 9);
    expect(memo.lab.length).toBe(0);
  });

  it('tells apart colours that hash to the same slot, including a chain that wraps past the last slot', () => {
    const memo = new ColourMemo(false);
    const lastSlot = (1 << INITIAL_SLOT_BITS) - 1;
    const colliding: number[] = [];
    for (let key = 0; colliding.length < 4 && key < 0x1000000; key += 1) if (slotOf(key, INITIAL_SLOT_BITS) === lastSlot) colliding.push(key);
    expect(colliding).toHaveLength(4);
    colliding.forEach((key, i) => memo.add(key, i + 10, 0, 0, 0, 0));
    colliding.forEach((key, i) => expect(memo.index[memo.find(key)]).toBe(i + 10));
    // The next key of the same chain is not in the memo, and the search for it must end instead of looping.
    let absent = colliding[3] + 1;
    while (slotOf(absent, INITIAL_SLOT_BITS) !== lastSlot) absent += 1;
    expect(memo.find(absent)).toBe(-1);
  });

  it('keeps every entry, with its answer, through two doublings of the table', () => {
    const memo = new ColourMemo(true);
    const random = lcg(11);
    const oracle = new Map<number, number>();
    while (oracle.size < INITIAL_ENTRIES * 3 + 5) {
      const key = Math.floor(random() * 0x1000000);
      if (oracle.has(key)) continue;
      const paletteIndex = oracle.size % 256;
      oracle.set(key, paletteIndex);
      memo.add(key, paletteIndex, key / 1e7, 1, 2, 3);
    }
    expect(memo.count).toBe(oracle.size);
    for (const [key, paletteIndex] of oracle) {
      const entry = memo.find(key);
      expect(entry).toBeGreaterThanOrEqual(0);
      expect(memo.index[entry]).toBe(paletteIndex);
      expect(memo.lab[entry * COLOUR_MEMO_LAB_STRIDE]).toBe(key / 1e7);
    }
  });

  it.each([1, 3, 100, 5000])('holds more colours than the %i it was told to expect', (expected) => {
    const memo = new ColourMemo(true, expected);
    for (let key = 0; key < 9000; key += 1) memo.add(key * 1861, key % 256, key, key + 1, key + 2, key + 3);
    for (let key = 0; key < 9000; key += 1) {
      const entry = memo.find(key * 1861);
      expect(entry).toBe(key);
      expect(memo.index[entry]).toBe(key % 256);
      expect(Array.from(memo.lab.subarray(entry * COLOUR_MEMO_LAB_STRIDE, (entry + 1) * COLOUR_MEMO_LAB_STRIDE))).toEqual([key, key + 1, key + 2, key + 3]);
    }
  });

  it('empties itself when it holds its limit, and holds the colours added after', () => {
    const memo = new ColourMemo(true, Infinity, 40);
    for (let key = 0; key < 40; key += 1) memo.add(key, key, 0, 0, 0, 0);
    expect(memo.count).toBe(40);
    expect(memo.find(0)).toBeGreaterThanOrEqual(0);
    const entry = memo.add(1000, 5, 1, 2, 3, 4);
    expect(entry).toBe(0);
    expect(memo.count).toBe(1);
    expect(memo.find(0)).toBe(-1);
    expect(memo.find(39)).toBe(-1);
    expect(memo.find(1000)).toBe(0);
    expect(memo.index[0]).toBe(5);
    expect(Array.from(memo.lab.subarray(0, COLOUR_MEMO_LAB_STRIDE))).toEqual([1, 2, 3, 4]);
  });

  it('holds exactly its limit before it empties', () => {
    const memo = new ColourMemo(false, Infinity, 3);
    memo.add(1, 1, 0, 0, 0, 0);
    memo.add(2, 2, 0, 0, 0, 0);
    expect(memo.add(3, 3, 0, 0, 0, 0)).toBe(2);
    expect(memo.find(1)).toBe(0);
    expect(memo.add(4, 4, 0, 0, 0, 0)).toBe(0);
    expect(memo.find(1)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Mapping through the memo
// ---------------------------------------------------------------------------------------------------------------

const linear = (code: number): number => {
  const v = code / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** Oklab of an sRGB triple by Ottosson's published matrices. */
function oklab(r: number, g: number, b: number): [number, number, number] {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function distance2(a: readonly number[], b: readonly number[]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Palette indices within rounding of the smallest distance to `colour` (a tie in the last digits may go either way). */
function nearestSet(colour: readonly number[], palette: ReadonlyArray<readonly number[]>): { set: number[]; best: number } {
  const target = oklab(colour[0], colour[1], colour[2]);
  const distances = palette.map((p) => distance2(target, oklab(p[0], p[1], p[2])));
  const best = Math.min(...distances);
  return { set: distances.flatMap((d, i) => (d <= best * (1 + 1e-9) + 1e-18 ? [i] : [])), best };
}

function randomPalette(count: number, seed: number): number[][] {
  const random = lcg(seed);
  return Array.from({ length: count }, () => [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)]);
}

function distinctColours(count: number, seed: number): number[][] {
  const random = lcg(seed);
  const seen = new Set<number>();
  const colours: number[][] = [];
  while (colours.length < count) {
    const key = Math.floor(random() * 0x1000000);
    if (seen.has(key)) continue;
    seen.add(key);
    colours.push([key >> 16, (key >> 8) & 255, key & 255]);
  }
  return colours;
}

function raster(colours: ReadonlyArray<readonly number[]>): Uint8Array {
  const pixels = new Uint8Array(colours.length * 4);
  colours.forEach((c, i) => pixels.set([c[0], c[1], c[2], 255], i * 4));
  return pixels;
}

describe('palette mapping through the colour memo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps every pixel to a nearest palette colour of a full scan', () => {
    const palette = randomPalette(48, 3);
    const colours = distinctColours(6000, 4);
    const indices = mapToPalette(raster(colours), colours.length, 1, Uint8Array.from(palette.flat()), palette.length, 'none');
    colours.forEach((colour, p) => expect(nearestSet(colour, palette).set).toContain(indices[p]));
  });

  it('searches the palette once for each distinct colour, however often and in whatever order the colours come back', () => {
    const palette = randomPalette(64, 5);
    const distinct = distinctColours(40_000, 6);
    // The old direct-mapped cache held 16,384 colours and lost the ones that shared a slot; three passes in different orders show it.
    const random = lcg(7);
    const order = [...distinct, ...[...distinct].sort(() => random() - 0.5), ...[...distinct].sort(() => random() - 0.5)];
    const search = vi.spyOn(KdTree3.prototype, 'nearestIndex');
    const indices = mapToPalette(raster(order), order.length, 1, Uint8Array.from(palette.flat()), palette.length, 'none');
    expect(search).toHaveBeenCalledTimes(distinct.length);
    // The answer for a colour does not depend on the pass it came in.
    const answer = new Map<number, number>();
    order.forEach((c, p) => {
      const key = (c[0] << 16) | (c[1] << 8) | c[2];
      if (!answer.has(key)) answer.set(key, indices[p]);
      expect(indices[p]).toBe(answer.get(key));
    });
  });

  it('searches the palette once for each distinct colour of a picture that shows each of them twice', () => {
    const palette = randomPalette(16, 8);
    const distinct = distinctColours(1500, 9);
    const search = vi.spyOn(KdTree3.prototype, 'nearestIndex');
    mapToPalette(raster([...distinct, ...distinct]), distinct.length * 2, 1, Uint8Array.from(palette.flat()), palette.length, 'none');
    expect(search).toHaveBeenCalledTimes(distinct.length);
  });

  describe('with a run tolerance', () => {
    const TOLERANCE = 0.25;
    const palette = randomPalette(40, 12);
    const colours = distinctColours(8000, 13);
    // Neighbouring pixels of a similar colour, so that "keep the previous colour" is often within reach.
    const random = lcg(14);
    const walk = colours.flatMap((c) => [c, [Math.min(255, c[0] + 2), c[1], c[2]], [c[0], Math.max(0, c[1] - 3), c[2]], c]);
    const picture = [...walk, ...walk.slice(0, 2000).map((c) => (random() < 0.5 ? c : [c[0], c[1], Math.min(255, c[2] + 1)]))];
    const indices = mapToPalette(raster(picture), picture.length, 1, Uint8Array.from(palette.flat()), palette.length, 'none', -1, TOLERANCE);

    it('keeps the previous pixel\'s colour when it is within (1 + tolerance) of the distance to the nearest, and maps to a nearest otherwise', () => {
      const factor2 = (1 + TOLERANCE) ** 2;
      const EDGE = 1e-6;
      let kept = 0;
      let switched = 0;
      picture.forEach((colour, p) => {
        if (p === 0) return;
        const previous = indices[p - 1];
        const before = picture[p - 1];
        if (before[0] === colour[0] && before[1] === colour[1] && before[2] === colour[2]) {
          expect(indices[p]).toBe(previous);
          return;
        }
        const { set, best } = nearestSet(colour, palette);
        const previousDistance = distance2(oklab(colour[0], colour[1], colour[2]), oklab(palette[previous][0], palette[previous][1], palette[previous][2]));
        if (set.includes(previous)) {
          expect(set).toContain(indices[p]);
        } else if (previousDistance < best * factor2 * (1 - EDGE)) {
          expect(indices[p]).toBe(previous);
          kept += 1;
        } else if (previousDistance > best * factor2 * (1 + EDGE)) {
          expect(set).toContain(indices[p]);
          switched += 1;
        }
      });
      // Both decisions occur often, so a bound that is off by a factor shows in one of the two checks.
      expect(kept).toBeGreaterThan(500);
      expect(switched).toBeGreaterThan(500);
    });
  });
});
