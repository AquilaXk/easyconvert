/**
 * DDS files that keep their pixel format in the DX10 extension header (Microsoft DDS programming guide, "DDS_HEADER_DXT10").
 * ImageMagick 7.1.1 reads only some of them (R8G8B8A8_UNORM_SRGB is refused as "image type not supported") and ImageMagick 6
 * none, while every ImageMagick reads the same bytes under the legacy header, where the pixel format is a set of channel masks.
 * The uncompressed 8-bit four-channel formats are therefore handed over under that legacy header: the extension header is
 * dropped and the surface bytes are not touched. Compressed formats (BC1 to BC7) and every other layout are left as they are.
 */

const DDS_MAGIC = 'DDS ';
/** The magic and the 124-byte DDS_HEADER. */
const FILE_HEADER_BYTES = 128;
const DX10_HEADER_BYTES = 20;

/** Offsets inside DDS_PIXELFORMAT, which starts at byte 76 of the file. */
const PIXEL_FORMAT_FLAGS_AT = 80;
const PIXEL_FORMAT_FOURCC_AT = 84;
const PIXEL_FORMAT_BIT_COUNT_AT = 88;
const PIXEL_FORMAT_MASKS_AT = 92;

const DX10_FOURCC = 'DX10';
/** Offsets inside DDS_HEADER_DXT10, which follows the file header. */
const DXGI_FORMAT_AT = FILE_HEADER_BYTES;
const RESOURCE_DIMENSION_AT = FILE_HEADER_BYTES + 4;
const RESOURCE_DIMENSION_TEXTURE_2D = 3;

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_RGB = 0x40;
const BITS_PER_PIXEL = 32;

/** The A8R8G8B8 pixel format (D3DFMT_A8R8G8B8, the one every DDS reader supports): the bytes of a pixel are blue, green, red, alpha. */
const MASK_RED = 0x00ff0000;
const MASK_GREEN = 0x0000ff00;
const MASK_BLUE = 0x000000ff;
const MASK_ALPHA = 0xff000000;
const BYTES_PER_PIXEL = 4;
const BLUE_BYTE = 0;
const RED_BYTE = 2;

/** DXGI_FORMAT values (Microsoft DXGI_FORMAT enumeration) that store red first: R8G8B8A8 TYPELESS, UNORM and UNORM_SRGB. */
const RED_FIRST_FORMATS: ReadonlySet<number> = new Set([27, 28, 29]);
/** DXGI_FORMAT values that store blue first, as A8R8G8B8 does: B8G8R8A8 UNORM, TYPELESS and UNORM_SRGB. */
const BLUE_FIRST_FORMATS: ReadonlySet<number> = new Set([87, 90, 91]);

/** Exchanges red and blue in every pixel of `buffer` from `start` on, in place. */
function exchangeRedAndBlue(buffer: Buffer, start: number): void {
  for (let at = start; at + RED_BYTE < buffer.length; at += BYTES_PER_PIXEL) {
    const blue = buffer[at + BLUE_BYTE];
    buffer[at + BLUE_BYTE] = buffer[at + RED_BYTE];
    buffer[at + RED_BYTE] = blue;
  }
}

/**
 * `dds` with the DX10 header of an uncompressed R8G8B8A8 or B8G8R8A8 two-dimensional texture replaced by the A8R8G8B8 legacy pixel
 * format, or `dds` itself (the same object) for any other file. Red and blue are exchanged in the bytes of an R8G8B8A8 file rather
 * than described by red-first masks, because ImageMagick 7.1.1 and 7.1.2 read those masks in different orders (measured on
 * 7.1.1-43 and 7.1.2-29) and both read A8R8G8B8 alike. The colour values are not converted: the sRGB variants of the formats name
 * how the values are meant to be read, not different values.
 */
export function withLegacyDdsPixelFormat(dds: Buffer): Buffer {
  if (dds.length < FILE_HEADER_BYTES + DX10_HEADER_BYTES || dds.toString('latin1', 0, DDS_MAGIC.length) !== DDS_MAGIC) return dds;
  if (dds.toString('latin1', PIXEL_FORMAT_FOURCC_AT, PIXEL_FORMAT_FOURCC_AT + DX10_FOURCC.length) !== DX10_FOURCC) return dds;
  const format = dds.readUInt32LE(DXGI_FORMAT_AT);
  const redFirst = RED_FIRST_FORMATS.has(format);
  if ((!redFirst && !BLUE_FIRST_FORMATS.has(format)) || dds.readUInt32LE(RESOURCE_DIMENSION_AT) !== RESOURCE_DIMENSION_TEXTURE_2D) return dds;
  // One allocation holds the new header and the surface, so the file is copied once.
  const legacy = Buffer.allocUnsafe(dds.length - DX10_HEADER_BYTES);
  dds.copy(legacy, 0, 0, FILE_HEADER_BYTES);
  dds.copy(legacy, FILE_HEADER_BYTES, FILE_HEADER_BYTES + DX10_HEADER_BYTES);
  legacy.writeUInt32LE(DDPF_RGB | DDPF_ALPHAPIXELS, PIXEL_FORMAT_FLAGS_AT);
  legacy.fill(0, PIXEL_FORMAT_FOURCC_AT, PIXEL_FORMAT_FOURCC_AT + DX10_FOURCC.length);
  legacy.writeUInt32LE(BITS_PER_PIXEL, PIXEL_FORMAT_BIT_COUNT_AT);
  [MASK_RED, MASK_GREEN, MASK_BLUE, MASK_ALPHA].forEach((mask, index) => legacy.writeUInt32LE(mask, PIXEL_FORMAT_MASKS_AT + index * Uint32Array.BYTES_PER_ELEMENT));
  if (redFirst) exchangeRedAndBlue(legacy, FILE_HEADER_BYTES);
  return legacy;
}
