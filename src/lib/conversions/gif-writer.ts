import { ConversionFailedError } from '../types';

/**
 * GIF89a writer for one indexed frame: the palette it is given goes into the global colour table as it is
 * (no second quantization), with the LZW coding of the GIF specification (variable code size from min+1 to 12
 * bits, clear code when the table is full) and an optional transparent index.
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

class BitSink {
  private bytes = new Uint8Array(1 << 16);
  length = 0;
  private accumulator = 0;
  private accumulated = 0;

  private push(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length] = byte;
    this.length += 1;
  }

  write(code: number, bits: number): void {
    this.accumulator |= code << this.accumulated;
    this.accumulated += bits;
    while (this.accumulated >= 8) {
      this.push(this.accumulator & 0xff);
      this.accumulator >>>= 8;
      this.accumulated -= 8;
    }
  }

  flush(): Uint8Array {
    if (this.accumulated > 0) this.push(this.accumulator & 0xff);
    return this.bytes.subarray(0, this.length);
  }
}

/** LZW codes of the index stream, LSB-first packed, in the variant the GIF specification defines. */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const sink = new BitSink();
  const hashKeys = new Int32Array(HASH_SIZE).fill(-1);
  const hashCodes = new Uint16Array(HASH_SIZE);
  let freeEntry = clearCode + 2;
  let codeBits = minCodeSize + 1;
  let maxCode = (1 << codeBits) - 1;

  const output = (code: number, afterClear = false): void => {
    sink.write(code, codeBits);
    if (afterClear) {
      codeBits = minCodeSize + 1;
      maxCode = (1 << codeBits) - 1;
    } else if (freeEntry > maxCode) {
      codeBits += 1;
      maxCode = codeBits === MAX_CODE_BITS ? TABLE_LIMIT : (1 << codeBits) - 1;
    }
  };

  output(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const byte = indices[i];
    const key = (byte << MAX_CODE_BITS) + prefix;
    let slot = Math.imul(key, HASH_MULTIPLIER) >>> (32 - HASH_BITS);
    let found = false;
    while (hashKeys[slot] !== -1) {
      if (hashKeys[slot] === key) {
        prefix = hashCodes[slot];
        found = true;
        break;
      }
      slot = (slot + 1) & HASH_MASK;
    }
    if (found) continue;
    output(prefix);
    prefix = byte;
    if (freeEntry < TABLE_LIMIT) {
      hashKeys[slot] = key;
      hashCodes[slot] = freeEntry;
      freeEntry += 1;
    } else {
      hashKeys.fill(-1);
      freeEntry = clearCode + 2;
      output(clearCode, true);
    }
  }
  output(prefix);
  output(endCode);
  return sink.flush();
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
