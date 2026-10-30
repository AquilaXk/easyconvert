import { ConversionFailedError } from '../types';

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

/**
 * The font data of an EOT file: the last `FontDataSize` bytes, XOR-decrypted with 0x50 when the flag says so (libeot `eot2ttf` does
 * the same). A font compressed with MicroType Express is refused by that name, and a size the file cannot hold is refused.
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
