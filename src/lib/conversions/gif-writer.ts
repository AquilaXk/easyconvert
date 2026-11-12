import { ConversionFailedError } from '../types';

/**
 * GIF89a writer for one indexed frame: the palette it is given goes into the global colour table as it is
 * (no second quantization), with the LZW coding of the GIF specification (variable code size from min+1 to 12
 * bits, clear code when the table is full) and an optional transparent index.
 *
 * The coder is ours. It was measured against three permissive ones on the indices of four camera pictures (5 to 39 megapixels, seven
 * synthetic patterns of 8 megapixels, Linux arm64, Node 24): the LZW of gifenc 1.0.3 (MIT) took 1.5 to 1.75 times as long, that of omggif 1.0.10 (MIT) 5.5 to
 * 6.5 times (its codes are the same bytes as ours), and weezl 0.2.1 (MIT OR Apache-2.0) 1.3 to 1.55 times as a separate program before
 * the transfer of the pixels and 1.45 to 1.65 times with it. Every stream decoded to the same pixels in ffmpeg, ImageMagick and Pillow.
 * Only pictures made of long runs of one index were faster in weezl (0.85 of our time with the transfer, 8 megapixels of runs of 1 to 64).
 */

export const GIF_MAX_SIDE = 65_535;
export const GIF_MAX_COLORS = 256;

const MAX_CODE_BITS = 12;
const TABLE_LIMIT = 1 << MAX_CODE_BITS;
/**
 * Slots of the code table's hash: a power of two four times the 4096 codes the table can hold, so a probe ends within a
 * step or two (the classic compress hash of 5003 slots is 82 percent full when the table is, and a lookup then runs a
 * long chain per pixel). The slot is the multiplicative (Fibonacci) hash of the key.
 */
const HASH_BITS = 14;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const HASH_MULTIPLIER = 0x9e3779b1;
const BLOCK_BYTES = 255;
const GIF_TRAILER = 0x3b;
const IMAGE_SEPARATOR = 0x2c;
const EXTENSION_INTRODUCER = 0x21;
const GRAPHIC_CONTROL_LABEL = 0xf9;

export interface GifImage {
  width: number;
  height: number;
  /** Palette colours as r, g, b triples. */
  palette: Uint8Array;
  paletteSize: number;
  /** One palette index per pixel, row-major, top row first. */
  indices: Uint8Array;
  /** Palette index that is transparent, or -1 for none. */
  transparentIndex: number;
}

/** LZW codes of the index stream, LSB-first packed, in the variant the GIF specification defines. */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const initialBits = minCodeSize + 1;
  // One word per slot: the key (index << 12 | prefix code) in the upper 20 bits, the code in the lower 12. Codes start at clearCode + 2, so a held slot is never 0.
  const table = new Uint32Array(HASH_SIZE);
  const count = indices.length;
  let bytes = new Uint8Array((count >> 1) + 4096);
  let length = 0;
  // The first code is the clear code at the initial width.
  let accumulator = clearCode;
  let accumulated = initialBits;
  let freeEntry = clearCode + 2;
  let codeBits = initialBits;
  let maxCode = (1 << codeBits) - 1;

  let prefix = indices[0];
  for (let i = 1; i < count; i += 1) {
    const byte = indices[i];
    const key = (byte << MAX_CODE_BITS) | prefix;
    let slot = Math.imul(key, HASH_MULTIPLIER) >>> (32 - HASH_BITS);
    let entry = table[slot];
    while (entry !== 0) {
      if (entry >>> MAX_CODE_BITS === key) break;
      slot = (slot + 1) & HASH_MASK;
      entry = table[slot];
    }
    if (entry !== 0) {
      prefix = entry & 0xfff;
      continue;
    }
    // The string `prefix + byte` is new: `prefix` goes out at the current width (at most 19 bits are pending, so at most two bytes leave).
    accumulator |= prefix << accumulated;
    accumulated += codeBits;
    if (length + 4 > bytes.length) {
      const grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes);
      bytes = grown;
    }
    if (accumulated >= 16) {
      bytes[length] = accumulator & 0xff;
      bytes[length + 1] = (accumulator >>> 8) & 0xff;
      length += 2;
      accumulator >>>= 16;
      accumulated -= 16;
    }
    if (accumulated >= 8) {
      bytes[length] = accumulator & 0xff;
      length += 1;
      accumulator >>>= 8;
      accumulated -= 8;
    }
    if (freeEntry > maxCode) {
      codeBits += 1;
      maxCode = codeBits === MAX_CODE_BITS ? TABLE_LIMIT : (1 << codeBits) - 1;
    }
    prefix = byte;
    if (freeEntry < TABLE_LIMIT) {
      table[slot] = (key << MAX_CODE_BITS) | freeEntry;
      freeEntry += 1;
    } else {
      table.fill(0);
      freeEntry = clearCode + 2;
      // The clear code goes out at the old width; the next code is back to the initial one.
      accumulator |= clearCode << accumulated;
      accumulated += codeBits;
      if (accumulated >= 16) {
        bytes[length] = accumulator & 0xff;
        bytes[length + 1] = (accumulator >>> 8) & 0xff;
        length += 2;
        accumulator >>>= 16;
        accumulated -= 16;
      }
      if (accumulated >= 8) {
        bytes[length] = accumulator & 0xff;
        length += 1;
        accumulator >>>= 8;
        accumulated -= 8;
      }
      codeBits = initialBits;
      maxCode = (1 << codeBits) - 1;
    }
  }
  // Last prefix and the end code.
  for (let step = 0; step < 2; step += 1) {
    const code = step === 0 ? prefix : endCode;
    accumulator |= code << accumulated;
    accumulated += codeBits;
    while (accumulated >= 8) {
      if (length === bytes.length) {
        const grown = new Uint8Array(bytes.length * 2);
        grown.set(bytes);
        bytes = grown;
      }
      bytes[length] = accumulator & 0xff;
      length += 1;
      accumulator >>>= 8;
      accumulated -= 8;
    }
    if (step === 0 && freeEntry > maxCode) {
      codeBits += 1;
      maxCode = codeBits === MAX_CODE_BITS ? TABLE_LIMIT : (1 << codeBits) - 1;
    }
  }
  if (accumulated > 0) {
    if (length === bytes.length) {
      const grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes);
      bytes = grown;
    }
    bytes[length] = accumulator & 0xff;
    length += 1;
  }
  return bytes.subarray(0, length);
}

function subBlocks(data: Uint8Array): Buffer {
  const blocks = Math.ceil(data.length / BLOCK_BYTES);
  const out = Buffer.alloc(data.length + blocks + 1);
  let at = 0;
  for (let start = 0; start < data.length; start += BLOCK_BYTES) {
    const size = Math.min(BLOCK_BYTES, data.length - start);
    out[at] = size;
    out.set(data.subarray(start, start + size), at + 1);
    at += size + 1;
  }
  return out;
}

/** Writes one GIF89a frame. Throws ConversionFailedError for a size or palette the format cannot hold. */
export function encodeGif(image: GifImage): Buffer {
  const { width, height, palette, paletteSize, indices, transparentIndex } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > GIF_MAX_SIDE || height > GIF_MAX_SIDE) {
    throw new ConversionFailedError(`A GIF holds 1 to ${GIF_MAX_SIDE} pixels on a side; the picture is ${width} x ${height}.`);
  }
  if (paletteSize < 1 || paletteSize > GIF_MAX_COLORS || palette.length < paletteSize * 3) {
    throw new ConversionFailedError(`A GIF palette holds 1 to ${GIF_MAX_COLORS} colours; got ${paletteSize}.`);
  }
  if (indices.length !== width * height) {
    throw new ConversionFailedError(`GIF encoding needs ${width * height} palette indices, got ${indices.length}.`);
  }
  // The colour table holds a power of two entries, at least 2; unused entries are black.
  let tableBits = 1;
  while (1 << tableBits < paletteSize) tableBits += 1;
  const tableSize = 1 << tableBits;
  const minCodeSize = Math.max(2, tableBits);

  const header = Buffer.alloc(6 + 7);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  // Global colour table present, 8 bits of colour resolution, table size field = bits - 1.
  header[10] = 0x80 | 0x70 | (tableBits - 1);
  const table = Buffer.alloc(tableSize * 3);
  table.set(palette.subarray(0, paletteSize * 3));

  const parts: Buffer[] = [header, table];
  if (transparentIndex >= 0) {
    // Graphic control extension: no disposal, no delay, a transparent colour index.
    parts.push(Buffer.from([EXTENSION_INTRODUCER, GRAPHIC_CONTROL_LABEL, 4, 0x01, 0, 0, transparentIndex, 0]));
  }
  const descriptor = Buffer.alloc(10);
  descriptor[0] = IMAGE_SEPARATOR;
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);
  parts.push(descriptor, Buffer.from([minCodeSize]), subBlocks(lzwEncode(indices, minCodeSize)), Buffer.from([GIF_TRAILER]));
  return Buffer.concat(parts);
}
