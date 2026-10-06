import { readFileSync } from 'node:fs';

const CHANNELS = 3;
const TIFF_TAG_WIDTH = 256;
const TIFF_TAG_HEIGHT = 257;
const TIFF_TAG_BITS = 258;
const TIFF_TAG_STRIP_OFFSETS = 273;
const TIFF_TAG_SAMPLES = 277;
const TIFF_TAG_COMPRESSION = 259;
const TIFF_ENTRY_BYTES = 12;
const TIFF_TYPE_SHORT = 3;
const BITS_16 = 16;

/**
 * dcraw_emu writes little-endian, uncompressed, single-strip 16-bit RGB TIFF. The header is parsed here rather than by an
 * image library so that the 16-bit samples reach the test unchanged.
 */
export function readTiff16(file: string): { data: Uint16Array; width: number; height: number } {
  const bytes = readFileSync(file);
  if (bytes.toString('latin1', 0, 2) !== 'II') throw new Error(`${file}: expected a little-endian TIFF`);
  const tags = new Map<number, number>();
  const ifd = bytes.readUInt32LE(4);
  const entries = bytes.readUInt16LE(ifd);
  for (let i = 0; i < entries; i += 1) {
    const at = ifd + 2 + i * TIFF_ENTRY_BYTES;
    const type = bytes.readUInt16LE(at + 2);
    tags.set(bytes.readUInt16LE(at), type === TIFF_TYPE_SHORT ? bytes.readUInt16LE(at + 8) : bytes.readUInt32LE(at + 8));
  }
  const width = tags.get(TIFF_TAG_WIDTH)!;
  const height = tags.get(TIFF_TAG_HEIGHT)!;
  if (tags.get(TIFF_TAG_SAMPLES) !== CHANNELS || tags.get(TIFF_TAG_COMPRESSION) !== 1) throw new Error(`${file}: expected uncompressed RGB`);
  const bitsOffset = tags.get(TIFF_TAG_BITS)!;
  if (bytes.readUInt16LE(bitsOffset) !== BITS_16) throw new Error(`${file}: expected 16 bits per sample`);
  const offset = tags.get(TIFF_TAG_STRIP_OFFSETS)!;
  const samples = width * height * CHANNELS;
  const data = new Uint16Array(samples);
  for (let i = 0; i < samples; i += 1) data[i] = bytes.readUInt16LE(offset + i * Uint16Array.BYTES_PER_ELEMENT);
  return { data, width, height };
}
