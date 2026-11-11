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

/**
 * The code table: one 16-bit code for every (prefix code, next index) pair, at `prefix << minCodeSize | index`. A lookup is one load,
 * with no hash and no probe (the open-addressed table that came before it spent most of a miss in the probe loop). Code 0 is a
 * palette index, never the code of a string of two or more, so 0 means the pair is absent. The table is kept between encodes and the
 * slots a table filled are zeroed when it is cleared, so an encode costs no allocation or fill of its own.
 */
let codeTable = new Uint16Array(0);
/** The slots the current table holds, to zero them at a clear code. */
const heldSlots = new Int32Array(TABLE_LIMIT);
/**
 * A string of one index repeated (a flat area of a picture) is followed through two small tables instead of the large one: `runSymbol[code]` is
 * the index of which `code` is a run (-1 for any other string), `runChild[code]` the code of the run one longer (0 until it is in the table). Both
 * together are 12 KB, so they stay in the first level of the cache, where the large table does not: most pixels of a photograph reduced to a
 * palette with runs (see `QuantizeOptions.runTolerance`) extend a run.
 */
const runSymbol = new Int16Array(TABLE_LIMIT);
const runChild = new Uint16Array(TABLE_LIMIT);

/** LZW codes of the index stream, LSB-first packed, in the variant the GIF specification defines. */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const initialBits = minCodeSize + 1;
  const tableSlots = TABLE_LIMIT << minCodeSize;
  if (codeTable.length < tableSlots) codeTable = new Uint16Array(tableSlots);
  const table = codeTable;
  const count = indices.length;
  let bytes = new Uint8Array((count >> 1) + 4096);
  let length = 0;
  // The first code is the clear code at the initial width.
  let accumulator = clearCode;
  let accumulated = initialBits;
  let freeEntry = clearCode + 2;
  let held = 0;
  runSymbol.fill(-1);
  for (let c = 0; c < clearCode; c += 1) runSymbol[c] = c;
  let codeBits = initialBits;
  let maxCode = (1 << codeBits) - 1;

  try {
    let prefix = indices[0];
    for (let i = 1; i < count; i += 1) {
      const byte = indices[i];
      if (runSymbol[prefix] === byte) {
        const next = runChild[prefix];
        if (next !== 0) {
          prefix = next;
          continue;
        }
      }
      const slot = (prefix << minCodeSize) | byte;
      const found = table[slot];
      if (found !== 0) {
        prefix = found;
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
      const previous = prefix;
      prefix = byte;
      if (freeEntry < TABLE_LIMIT) {
        table[slot] = freeEntry;
        if (runSymbol[previous] === byte) {
          runChild[previous] = freeEntry;
          runSymbol[freeEntry] = byte;
        }
        heldSlots[held] = slot;
        held += 1;
        freeEntry += 1;
        continue;
      }
      // The table is full: clear it, and send the clear code at the width in force.
      for (let h = 0; h < held; h += 1) table[heldSlots[h]] = 0;
      held = 0;
      runSymbol.fill(-1, clearCode + 2);
      runChild.fill(0);
      freeEntry = clearCode + 2;
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
    // The last string, then the end code (at the width the last string's entry may have raised).
    const tail = new Uint8Array(8);
    let tailLength = 0;
    accumulator |= prefix << accumulated;
    accumulated += codeBits;
    if (freeEntry > maxCode) codeBits += 1;
    accumulator |= endCode << accumulated;
    accumulated += codeBits;
    while (accumulated > 0) {
      tail[tailLength] = accumulator & 0xff;
      tailLength += 1;
      accumulator >>>= 8;
      accumulated -= 8;
    }
    if (length + tailLength > bytes.length) {
      const grown = new Uint8Array(length + tailLength);
      grown.set(bytes.subarray(0, length));
      bytes = grown;
    }
    bytes.set(tail.subarray(0, tailLength), length);
    return bytes.subarray(0, length + tailLength);
  } finally {
    for (let h = 0; h < held; h += 1) table[heldSlots[h]] = 0;
    runChild.fill(0);
  }
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
