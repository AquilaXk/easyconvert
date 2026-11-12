import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_MEMO_MIN_PIXELS, mapToPalette } from '../src/lib/conversions/color-quantizer';
import { DirectColourMemo } from '../src/lib/conversions/image-colour-direct-memo';
import { COLOUR_MEMO_LAB_STRIDE, ColourMemo } from '../src/lib/conversions/image-colour-memo';

/**
 * The direct colour memo (a table indexed by the 24-bit colour) against the hashed `ColourMemo` it stands in for on a large raster:
 * the same entry numbers, answers and limit, and the same mapped picture, run tolerance included.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('direct colour memo', () => {
  it('finds nothing before an add and the entry it numbered after', () => {
    const memo = new DirectColourMemo(true);
    expect(memo.find(0x123456)).toBe(-1);
    expect(memo.find(0)).toBe(-1);
    const entry = memo.add(0x123456, 77, 0.5, 0.1, 0.2, 0.3);
    expect(memo.find(0x123456)).toBe(entry);
    expect(memo.index[entry]).toBe(77);
    const at = entry * COLOUR_MEMO_LAB_STRIDE;
    expect(Array.from(memo.lab.subarray(at, at + COLOUR_MEMO_LAB_STRIDE))).toEqual([0.5, 0.1, 0.2, 0.3]);
    expect(memo.find(0x123457)).toBe(-1);
  });

  it('numbers entries in the order they were added, and finds the colour black and the colour white', () => {
    const memo = new DirectColourMemo(false);
    expect([memo.add(0xffffff, 1, 0, 0, 0, 0), memo.add(9, 2, 0, 0, 0, 0), memo.add(0, 3, 0, 0, 0, 0)]).toEqual([0, 1, 2]);
    expect([memo.find(0xffffff), memo.find(9), memo.find(0)]).toEqual([0, 1, 2]);
    expect(memo.count).toBe(3);
    expect(memo.lab.length).toBe(0);
  });

  it('keeps every entry, with its answer, through the doublings of its arrays', () => {
    const memo = new DirectColourMemo(true);
    const random = lcg(11);
    const oracle = new Map<number, number>();
    while (oracle.size < (1 << 17) + 5) {
      const key = Math.floor(random() * 0x1000000);
      if (oracle.has(key)) continue;
      const paletteIndex = oracle.size % 256;
      oracle.set(key, paletteIndex);
      memo.add(key, paletteIndex, key / 1e7, 1, 2, 3);
    }
    expect(memo.count).toBe(oracle.size);
    const wrong: Array<{ key: number; entry: number }> = [];
    for (const [key, paletteIndex] of oracle) {
      const entry = memo.find(key);
      if (entry < 0 || memo.index[entry] !== paletteIndex || memo.lab[entry * COLOUR_MEMO_LAB_STRIDE] !== key / 1e7) wrong.push({ key, entry });
    }
    expect(wrong).toEqual([]);
  });

  it('empties itself when it holds its limit, and holds the colours added after', () => {
    const memo = new DirectColourMemo(true, 40);
    for (let key = 0; key < 40; key += 1) memo.add(key, key, 0, 0, 0, 0);
    expect(memo.count).toBe(40);
    expect(memo.find(0)).toBe(0);
    const entry = memo.add(1000, 5, 1, 2, 3, 4);
    expect(entry).toBe(0);
    expect(memo.count).toBe(1);
    expect(memo.find(0)).toBe(-1);
    expect(memo.find(39)).toBe(-1);
    expect(memo.find(1000)).toBe(0);
    expect(memo.index[0]).toBe(5);
    expect(Array.from(memo.lab.subarray(0, COLOUR_MEMO_LAB_STRIDE))).toEqual([1, 2, 3, 4]);
  });

  it('answers as the hashed memo does for the same sequence of colours, limit included', () => {
    const limit = 3000;
    const direct = new DirectColourMemo(true, limit);
    const hashed = new ColourMemo(true, Infinity, limit);
    const random = lcg(5);
    const colours = Array.from({ length: 2000 }, () => Math.floor(random() * 0x1000000));
    const different: number[] = [];
    for (let step = 0; step < 20_000; step += 1) {
      const key = colours[Math.floor(random() * colours.length)] ^ (random() < 0.3 ? 1 : 0);
      const a = direct.find(key);
      const b = hashed.find(key);
      if (a !== b) different.push(key);
      else if (a < 0) {
        const entryA = direct.add(key, step % 256, step, 1, 2, 3);
        const entryB = hashed.add(key, step % 256, step, 1, 2, 3);
        if (entryA !== entryB) different.push(key);
      } else if (direct.index[a] !== hashed.index[b]) different.push(key);
    }
    expect(different).toEqual([]);
    expect(direct.count).toBe(hashed.count);
  });
});

describe('palette mapping through the direct colour memo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/lib/conversions/image-colour-direct-memo');
  });

  /** A raster of `pixels` pixels whose colours drift over the whole range, with runs and near repeats for the run tolerance. */
  function picture(pixels: number, seed: number): Uint8Array {
    const random = lcg(seed);
    const out = new Uint8Array(pixels * 4);
    let r = 128;
    let g = 128;
    let b = 128;
    for (let p = 0; p < pixels; p += 1) {
      const step = random();
      if (step < 0.2) {
        r = Math.floor(random() * 256);
        g = Math.floor(random() * 256);
        b = Math.floor(random() * 256);
      } else if (step < 0.8) {
        r = Math.min(255, Math.max(0, r + Math.floor(random() * 5) - 2));
        g = Math.min(255, Math.max(0, g + Math.floor(random() * 5) - 2));
        b = Math.min(255, Math.max(0, b + Math.floor(random() * 5) - 2));
      }
      out.set([r, g, b, 255], p * 4);
    }
    return out;
  }

  const palette = Uint8Array.from(Array.from({ length: 96 * 3 }, (_, i) => Math.floor(lcg(i + 1)() * 256)));

  it('uses the direct table from the pixel count the constant names, and the hashed one below it', () => {
    const direct = vi.spyOn(DirectColourMemo.prototype, 'add');
    mapToPalette(picture(DIRECT_MEMO_MIN_PIXELS - 1, 2), DIRECT_MEMO_MIN_PIXELS - 1, 1, palette, 96, 'none');
    expect(direct).not.toHaveBeenCalled();
    mapToPalette(picture(DIRECT_MEMO_MIN_PIXELS, 2), DIRECT_MEMO_MIN_PIXELS, 1, palette, 96, 'none');
    expect(direct).toHaveBeenCalled();
  });

  it.each([0, 0.25])('maps a raster of the direct memo\'s size to the same indices as the hashed memo does (run tolerance %f)', async (tolerance) => {
    const pixels = picture(DIRECT_MEMO_MIN_PIXELS, 3);
    const withDirect = mapToPalette(pixels, DIRECT_MEMO_MIN_PIXELS, 1, palette, 96, 'none', -1, tolerance);
    vi.resetModules();
    vi.doMock('../src/lib/conversions/image-colour-direct-memo', async () => {
      const { ColourMemo: Hashed } = await import('../src/lib/conversions/image-colour-memo');
      return { DirectColourMemo: class extends Hashed { constructor(keepsLab: boolean) { super(keepsLab, DIRECT_MEMO_MIN_PIXELS); } } };
    });
    const hashedModule = await import('../src/lib/conversions/color-quantizer');
    const withHash = hashedModule.mapToPalette(pixels, DIRECT_MEMO_MIN_PIXELS, 1, palette, 96, 'none', -1, tolerance);
    expect(Buffer.from(withDirect).equals(Buffer.from(withHash))).toBe(true);
  });
});
