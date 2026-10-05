/**
 * PIZ block inspection and hostile-block construction for OpenEXR tests.
 *
 * Authored from the OpenEXR file layout specification (PIZ compression): a block holds the
 * used-value bitmap range, the bitmap bytes, the Huffman stream length and the canonical Huffman
 * stream (a 20-byte header, a run-length-packed table of 6-bit code lengths, then the code bits,
 * MSB first). The reader only measures a block; the writer emits a block of a chosen shape. Neither
 * shares code with the decoder under test.
 */

import { exrChunkOffsets } from './exr-assemble';

const BYTES_PER_INT32 = 4;
const SCANLINE_CHUNK_HEADER_BYTES = 8;
const BITMAP_VALUES_PER_BYTE = 8;
const BITMAP_BYTES = 8192;
const HUFFMAN_HEADER_BYTES = 20;
const HUFFMAN_LENGTH_BITS = 6;
const SHORT_ZERO_RUN = 59;
const LONG_ZERO_RUN = 63;
const SHORTEST_LONG_RUN = 2 + LONG_ZERO_RUN - SHORT_ZERO_RUN;
const RUN_COUNT_BITS = 8;
const BITS_PER_BYTE = 8;
const SYMBOL_COUNT = 65537;
const LAST_DATA_SYMBOL = 65535;
const REPEAT_SYMBOL = 65536;
const MAX_REPEAT = 255;
const EMPTY_BITMAP_MIN = BITMAP_BYTES - 1;

export interface PizBlockStats {
  /** Highest value index after the reverse lookup table is applied; at or above 2^14 selects the 16-bit wavelet. */
  maxValue: number;
  /** Longest Huffman code length in bits; above 14 needs the long-code path. */
  longestCodeBits: number;
}

/** Counts the values marked in the used-value bitmap; value 0 is implicit and never counted. */
function countBitmapValues(file: Buffer, pos: number, minNonZero: number, maxNonZero: number): number {
  let used = 0;
  for (let index = 0; index <= maxNonZero - minNonZero; index++) {
    const byte = file[pos + index];
    for (let bit = 0; bit < BITMAP_VALUES_PER_BYTE; bit++) {
      const value = (minNonZero + index) * BITMAP_VALUES_PER_BYTE + bit;
      if (value !== 0 && (byte & (1 << bit)) !== 0) used++;
    }
  }
  return used;
}

/** Longest code length in the run-length-packed table of 6-bit lengths that follows the Huffman header. */
function longestTableCodeLength(file: Buffer, huffmanStart: number): number {
  const firstSymbol = file.readUInt32LE(huffmanStart);
  const lastSymbol = file.readUInt32LE(huffmanStart + 4);
  let bitPos = (huffmanStart + HUFFMAN_HEADER_BYTES) * BITS_PER_BYTE;
  const readBits = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = value * 2 + ((file[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return value;
  };

  let longest = 0;
  for (let symbol = firstSymbol; symbol <= lastSymbol; symbol++) {
    const length = readBits(HUFFMAN_LENGTH_BITS);
    if (length < SHORT_ZERO_RUN) {
      longest = Math.max(longest, length);
    } else {
      symbol += zeroRun(length, readBits) - 1;
    }
  }
  return longest;
}

/** Symbols skipped by a zero-run marker (59..63). */
function zeroRun(marker: number, readBits: (count: number) => number): number {
  if (marker === LONG_ZERO_RUN) return readBits(RUN_COUNT_BITS) + SHORTEST_LONG_RUN;
  return marker - SHORT_ZERO_RUN + 2;
}

/** Measures the first chunk of a PIZ scanline file. */
export function pizFirstBlockStats(file: Buffer): PizBlockStats {
  const [first] = exrChunkOffsets(file, 1);
  let pos = first + SCANLINE_CHUNK_HEADER_BYTES;
  const minNonZero = file.readUInt16LE(pos);
  const maxNonZero = file.readUInt16LE(pos + 2);
  pos += 4;

  let usedValues = 0;
  if (minNonZero <= maxNonZero) {
    usedValues = countBitmapValues(file, pos, minNonZero, maxNonZero);
    pos += maxNonZero - minNonZero + 1;
  }
  pos += BYTES_PER_INT32; // Huffman stream length
  return { maxValue: usedValues, longestCodeBits: longestTableCodeLength(file, pos) };
}

class BitWriter {
  private readonly bytes: number[] = [];
  private bitCount = 0;

  /** Appends `count` bits of `value`, most significant first. */
  write(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      const bit = Math.floor(value / 2 ** i) % 2;
      if ((this.bitCount & 7) === 0) this.bytes.push(0);
      if (bit === 1) this.bytes[this.bytes.length - 1] |= 1 << (7 - (this.bitCount & 7));
      this.bitCount++;
    }
  }

  get bits(): number {
    return this.bitCount;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/**
 * A PIZ chunk payload (for `wordCount` 16-bit words) whose Huffman table gives all 65537 symbols the
 * same code length. Canonical codes then equal the symbol numbers, so the stream is a few
 * `symbol, repeat` pairs using the largest data symbol: every code is long and sits at the end of the
 * range, the worst case for a decoder that searches codes linearly. Payload size stays below the
 * uncompressed size, so the decoder treats it as compressed.
 */
export function buildUniformLongCodePizPayload(wordCount: number, codeBits: number): Buffer {
  const table = new BitWriter();
  for (let symbol = 0; symbol < SYMBOL_COUNT; symbol++) table.write(codeBits, HUFFMAN_LENGTH_BITS);

  const stream = new BitWriter();
  let remaining = wordCount;
  while (remaining > 0) {
    stream.write(LAST_DATA_SYMBOL, codeBits);
    remaining -= 1;
    const repeat = Math.min(MAX_REPEAT, remaining);
    if (repeat > 0) {
      stream.write(REPEAT_SYMBOL, codeBits);
      stream.write(repeat, RUN_COUNT_BITS);
      remaining -= repeat;
    }
  }

  const tableBytes = table.toBuffer();
  const header = Buffer.alloc(HUFFMAN_HEADER_BYTES);
  header.writeUInt32LE(0, 0);
  header.writeUInt32LE(REPEAT_SYMBOL, 4);
  header.writeUInt32LE(tableBytes.length, 8);
  header.writeUInt32LE(stream.bits, 12);
  const huffman = Buffer.concat([header, tableBytes, stream.toBuffer()]);

  const blockHeader = Buffer.alloc(2 * 2 + BYTES_PER_INT32);
  blockHeader.writeUInt16LE(EMPTY_BITMAP_MIN, 0); // minNonZero > maxNonZero: the bitmap is empty
  blockHeader.writeUInt16LE(0, 2);
  blockHeader.writeInt32LE(huffman.length, 4);
  return Buffer.concat([blockHeader, huffman]);
}
