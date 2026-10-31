import { ConversionFailedError, PayloadLimitError } from '../types';

/** Embedded OpenType header facts (W3C member submission "Embedded OpenType (EOT) File Format"; Flags at offset 12). */
const EOT_HEADER_MIN_BYTES = 36;
const EOT_FONT_DATA_SIZE_OFFSET = 4;
const EOT_FLAGS_OFFSET = 12;
const EOT_MAGIC_OFFSET = 34;
const EOT_MAGIC = 0x504c;
const EOT_FLAG_COMPRESSED = 0x4;
const EOT_FLAG_XOR_ENCRYPTED = 0x10000000;
const EOT_XOR_KEY = 0x50;
const SFNT_HEADER_BYTES = 12;
/** The MTX stream starts with a version byte, the 24-bit copy limit and the 24-bit offsets of its second and third block (W3C member submission "MicroType Express (MTX) Font Format", libeot `unpackMtx`). */
const MTX_HEADER_BYTES = 10;
const MTX_BLOCK2_OFFSET_AT = 4;
const MTX_BLOCK3_OFFSET_AT = 7;
/** Each of the three LZCOMP blocks states its decompressed size in 24 bits (libeot `MTX_LZCOMP_UnPackMemory`), so no stream decompresses to more than three times 16 MiB. */
const MTX_BLOCK_COUNT = 3;
const MTX_BLOCK_MAX_BYTES = 1 << 24;
const MTX_MAX_STREAM_BYTES = MTX_BLOCK_COUNT * MTX_BLOCK_MAX_BYTES;

/** True for a file with the EOT signature whose header says the font data is compressed with MicroType Express. */
export function isMtxCompressedEot(buffer: Buffer): boolean {
  return buffer.length >= EOT_HEADER_MIN_BYTES && buffer.readUInt16LE(EOT_MAGIC_OFFSET) === EOT_MAGIC && (buffer.readUInt32LE(EOT_FLAGS_OFFSET) & EOT_FLAG_COMPRESSED) !== 0;
}

/**
 * Checks the container of an MTX compressed EOT file before a C decoder reads it, which does not check what it reads: the font data it
 * declares must fit in the file and in the MTX limits, and the offsets of the second and third block must lie inside it in order (an offset
 * before the end of the header made libeot read a block of four billion bytes). Returns the file unchanged.
 */
export function checkedMtxEot(buffer: Buffer): Buffer {
  const fontDataSize = buffer.readUInt32LE(EOT_FONT_DATA_SIZE_OFFSET);
  if (fontDataSize < MTX_HEADER_BYTES || fontDataSize > buffer.length) {
    throw new ConversionFailedError('Invalid EOT font: the font data it declares does not fit in the file.');
  }
  if (fontDataSize > MTX_MAX_STREAM_BYTES) {
    throw new PayloadLimitError(`The compressed font data is ${fontDataSize} bytes; MicroType Express holds at most ${MTX_MAX_STREAM_BYTES} bytes (three blocks of 16 MiB).`);
  }
  const stream = buffer.subarray(buffer.length - fontDataSize);
  const key = (buffer.readUInt32LE(EOT_FLAGS_OFFSET) & EOT_FLAG_XOR_ENCRYPTED) !== 0 ? EOT_XOR_KEY : 0;
  const offsetAt = (at: number): number => ((stream[at] ^ key) << 16) | ((stream[at + 1] ^ key) << 8) | (stream[at + 2] ^ key);
  const block2 = offsetAt(MTX_BLOCK2_OFFSET_AT);
  const block3 = offsetAt(MTX_BLOCK3_OFFSET_AT);
  if (block2 < MTX_HEADER_BYTES || block3 < block2 || block3 > fontDataSize) {
    throw new ConversionFailedError('Invalid EOT font: the blocks of its MicroType Express data do not lie inside it.');
  }
  return buffer;
}

/**
 * The font data of an EOT file: the last `FontDataSize` bytes, XOR-decrypted with 0x50 when the flag says so (libeot `eot2ttf` does
 * the same). A font compressed with MicroType Express is refused by that name here (convertFont sends such a file to eot2ttf, font-eot-mtx.ts, before it gets here), and a size the file cannot hold is refused.
 */
export function eotFontData(buffer: Buffer): Buffer {
  if (buffer.length < EOT_HEADER_MIN_BYTES || buffer.readUInt16LE(EOT_MAGIC_OFFSET) !== EOT_MAGIC) {
    throw new ConversionFailedError('Invalid EOT font: missing LP signature at offset 34.');
  }
  const fontDataSize = buffer.readUInt32LE(EOT_FONT_DATA_SIZE_OFFSET);
  const flags = buffer.readUInt32LE(EOT_FLAGS_OFFSET);
  if ((flags & EOT_FLAG_COMPRESSED) !== 0) {
    throw new ConversionFailedError('This EOT font is compressed with MicroType Express (MTX), which this service does not decompress, so its outlines cannot be read.');
  }
  if (fontDataSize < SFNT_HEADER_BYTES || fontDataSize > buffer.length) {
    throw new ConversionFailedError('Invalid EOT font: the font data it declares does not fit in the file.');
  }
  const fontData = Buffer.from(buffer.subarray(buffer.length - fontDataSize));
  if ((flags & EOT_FLAG_XOR_ENCRYPTED) !== 0) for (let at = 0; at < fontData.length; at += 1) fontData[at] ^= EOT_XOR_KEY;
  return fontData;
}
