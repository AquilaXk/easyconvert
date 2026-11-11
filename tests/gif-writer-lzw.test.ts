import { describe, expect, it } from 'vitest';
import { encodeGif, GIF_MAX_SIDE } from '../src/lib/conversions/gif-writer';

/**
 * The LZW stream of the GIF writer against two things written apart from it: a decoder that follows the GIF specification
 * (appendix F of GIF89a: codes of 3 to 12 bits, a table that restarts at a clear code), which proves every stream is a valid GIF that
 * decodes to the exact indices, and a plain encoder over a `Map`, which proves the stream is the one the specification's coder writes (the
 * clear code goes out when the 4096-entry table is full, the width grows after the code that fills a power of two).
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface DecodedGif {
  width: number;
  height: number;
  tableSize: number;
  transparentIndex: number;
  indices: Uint8Array;
  /** Widths at which the clear codes after the first were read: a clear code ends a full table, so each is 12. */
  restartWidths: number[];
}

function readSubBlocks(bytes: Uint8Array, start: number): { data: Uint8Array; end: number } {
  const parts: number[] = [];
  let at = start;
  for (;;) {
    const size = bytes[at];
    at += 1;
    if (size === 0) break;
    for (let i = 0; i < size; i += 1) parts.push(bytes[at + i]);
    at += size;
  }
  return { data: Uint8Array.from(parts), end: at };
}

/** A GIF decoder for one frame, from the specification. */
function decodeGif(file: Uint8Array): DecodedGif {
  expect(Buffer.from(file.subarray(0, 6)).toString('ascii')).toBe('GIF89a');
  const width = file[6] | (file[7] << 8);
  const height = file[8] | (file[9] << 8);
  const flags = file[10];
  expect(flags & 0x80, 'global colour table flag').toBe(0x80);
  const tableSize = 1 << ((flags & 7) + 1);
  let at = 13 + tableSize * 3;
  let transparentIndex = -1;
  if (file[at] === 0x21) {
    expect(file[at + 1]).toBe(0xf9);
    if (file[at + 3] & 1) transparentIndex = file[at + 6];
    at += 8;
  }
  expect(file[at], 'image separator').toBe(0x2c);
  expect(file[at + 5] | (file[at + 6] << 8)).toBe(width);
  expect(file[at + 7] | (file[at + 8] << 8)).toBe(height);
  at += 10;
  const minCodeSize = file[at];
  at += 1;
  const { data, end } = readSubBlocks(file, at);
  expect(file[end], 'trailer').toBe(0x3b);
  expect(end + 1).toBe(file.length);

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new Uint8Array(width * height);
  let outLength = 0;
  const restartWidths: number[] = [];
  // Each table entry is the previous code and the last index; its string is read back by walking the codes.
  const prefixOf = new Int32Array(4096);
  const suffixOf = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let width_ = minCodeSize + 1;
  let next = clearCode + 2;
  let previous = -1;
  let bitPosition = 0;
  let seenClear = 0;
  const firstOf = (code: number): number => {
    let c = code;
    while (c >= clearCode + 2) c = prefixOf[c];
    return c;
  };
  for (;;) {
    let code = 0;
    for (let b = 0; b < width_; b += 1) {
      const bit = (data[(bitPosition + b) >> 3] >> ((bitPosition + b) & 7)) & 1;
      code |= bit << b;
    }
    bitPosition += width_;
    expect(bitPosition, 'the stream ends with the end code').toBeLessThanOrEqual(data.length * 8);
    if (code === clearCode) {
      if (seenClear > 0) restartWidths.push(width_);
      seenClear += 1;
      width_ = minCodeSize + 1;
      next = clearCode + 2;
      previous = -1;
      continue;
    }
    if (code === endCode) break;
    let depth = 0;
    if (previous === -1) {
      expect(code, 'the first code after a clear is an index').toBeLessThan(clearCode);
      stack[depth] = code;
      depth += 1;
    } else {
      let walk = code;
      if (code > next) throw new Error(`code ${code} is beyond the next entry ${next}`);
      if (code === next) {
        stack[depth] = firstOf(previous);
        depth += 1;
        walk = previous;
      }
      while (walk >= clearCode + 2) {
        stack[depth] = suffixOf[walk];
        depth += 1;
        walk = prefixOf[walk];
      }
      stack[depth] = walk;
      depth += 1;
      if (next < 4096) {
        prefixOf[next] = previous;
        suffixOf[next] = stack[depth - 1];
        next += 1;
        if (next === 1 << width_ && width_ < 12) width_ += 1;
      }
    }
    while (depth > 0) {
      depth -= 1;
      out[outLength] = stack[depth];
      outLength += 1;
    }
    previous = code;
  }
  expect(outLength).toBe(width * height);
  return { width, height, tableSize, transparentIndex, indices: out, restartWidths };
}

/** The coder of the specification with a `Map` for its table, and the bits written one at a time. */
function referenceCodes(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const bits: number[] = [];
  let width = minCodeSize + 1;
  let limit = (1 << width) - 1;
  const write = (code: number): void => {
    for (let b = 0; b < width; b += 1) bits.push((code >> b) & 1);
  };
  const table = new Map<number, number>();
  let next = clearCode + 2;
  write(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const key = prefix * 256 + indices[i];
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    write(prefix);
    if (next > limit) {
      width += 1;
      limit = width === 12 ? 4096 : (1 << width) - 1;
    }
    prefix = indices[i];
    if (next < 4096) {
      table.set(key, next);
      next += 1;
    } else {
      table.clear();
      next = clearCode + 2;
      write(clearCode);
      width = minCodeSize + 1;
      limit = (1 << width) - 1;
    }
  }
  write(prefix);
  if (next > limit) width += 1;
  write(endCode);
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, at) => {
    bytes[at >> 3] |= bit << (at & 7);
  });
  return bytes;
}

/** Bits of the colour table: it holds a power of two entries, at least 2. */
function tableBitsOf(paletteSize: number): number {
  let bits = 1;
  while (1 << bits < paletteSize) bits += 1;
  return bits;
}

function minCodeSizeOf(paletteSize: number): number {
  return Math.max(2, tableBitsOf(paletteSize));
}

function paletteOf(size: number): Uint8Array {
  return Uint8Array.from({ length: size * 3 }, (_, i) => (i * 37 + 11) & 0xff);
}

/** The LZW data of a GIF file the writer made, without the sub-block framing. */
function lzwDataOf(file: Uint8Array, paletteSize: number, hasTransparency: boolean): Uint8Array {
  const at = 13 + (1 << tableBitsOf(paletteSize)) * 3 + (hasTransparency ? 8 : 0) + 10;
  return readSubBlocks(file, at + 1).data;
}

function write(width: number, height: number, paletteSize: number, indices: Uint8Array, transparentIndex = -1): Buffer {
  return encodeGif({ width, height, palette: paletteOf(paletteSize), paletteSize, indices, transparentIndex });
}

describe('GIF writer LZW stream', () => {
  it('writes a 1 x 1 picture', () => {
    const file = write(1, 1, 2, Uint8Array.of(1));
    const gif = decodeGif(file);
    expect([gif.width, gif.height, gif.tableSize]).toEqual([1, 1, 2]);
    expect([...gif.indices]).toEqual([1]);
  });

  it('writes the widest and the tallest picture a GIF holds', () => {
    const random = lcg(5);
    for (const [width, height] of [
      [GIF_MAX_SIDE, 1],
      [1, GIF_MAX_SIDE],
    ]) {
      const indices = Uint8Array.from({ length: width * height }, () => (random() < 0.7 ? 3 : Math.floor(random() * 5)));
      const gif = decodeGif(write(width, height, 5, indices));
      expect([gif.width, gif.height]).toEqual([width, height]);
      expect(Buffer.compare(gif.indices, indices)).toBe(0);
    }
  });

  it('keeps the transparent index of the graphic control extension', () => {
    const indices = Uint8Array.from({ length: 6 * 4 }, (_, i) => i % 3);
    const gif = decodeGif(write(6, 4, 3, indices, 2));
    expect(gif.transparentIndex).toBe(2);
    expect(Buffer.compare(gif.indices, indices)).toBe(0);
    expect(decodeGif(write(6, 4, 3, indices)).transparentIndex).toBe(-1);
  });

  it.each([2, 3, 4, 5, 16, 17, 255, 256])('writes the stream of the specification for a palette of %i colours', (paletteSize) => {
    const random = lcg(paletteSize * 101);
    const width = 90;
    const height = 70;
    // A random fifth of the picture is noise, the rest long runs: both kinds of table entry.
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i += 1) {
      indices[i] = i > 0 && random() < 0.8 ? indices[i - 1] : Math.floor(random() * paletteSize);
    }
    const file = write(width, height, paletteSize, indices);
    const gif = decodeGif(file);
    expect(gif.tableSize).toBe(1 << tableBitsOf(paletteSize));
    expect(Buffer.compare(gif.indices, indices)).toBe(0);
    expect(Buffer.compare(lzwDataOf(file, paletteSize, false), referenceCodes(indices, minCodeSizeOf(paletteSize)))).toBe(0);
  });

  it('restarts the table at 12 bits when its 4096 entries are used, as often as the picture needs', () => {
    const random = lcg(99);
    const width = 400;
    const height = 300;
    const indices = Uint8Array.from({ length: width * height }, () => Math.floor(random() * 256));
    const file = write(width, height, 256, indices);
    const gif = decodeGif(file);
    expect(Buffer.compare(gif.indices, indices)).toBe(0);
    // Noise gives a code per index or two, so 120,000 indices fill the table dozens of times.
    expect(gif.restartWidths.length).toBeGreaterThan(20);
    expect(new Set(gif.restartWidths)).toEqual(new Set([12]));
    expect(Buffer.compare(lzwDataOf(file, 256, false), referenceCodes(indices, 8))).toBe(0);
  });

  it('keeps the table of a long run of one index and starts the next picture clean', () => {
    // A run builds the strings of one index, 1, 2, 3 ... long; a second encode must not meet entries of the first.
    const run = new Uint8Array(100_000).fill(7);
    const first = write(1000, 100, 256, run);
    expect(Buffer.compare(decodeGif(first).indices, run)).toBe(0);
    const random = lcg(3);
    const mixed = Uint8Array.from({ length: 5000 }, () => (random() < 0.5 ? 7 : Math.floor(random() * 256)));
    const second = write(100, 50, 256, mixed);
    expect(Buffer.compare(decodeGif(second).indices, mixed)).toBe(0);
    expect(Buffer.compare(lzwDataOf(second, 256, false), referenceCodes(mixed, 8))).toBe(0);
  });
});
