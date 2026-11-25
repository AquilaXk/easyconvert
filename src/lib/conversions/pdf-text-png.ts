import zlib from 'node:zlib';

/**
 * The PNG of a small raster, written without the image library. The library's call costs about a millisecond whatever the size of the
 * picture (4 x 5 pixels: 1.08 ms, 100 x 100: 1.09 ms, 400 x 300: 1.65 ms; Linux VM, 4 cores), where deflating a few hundred bytes takes
 * microseconds (0.005 ms, 0.033 ms, 0.18 ms), and a page of a PDF can place thousands of small pictures. The file is the plain one of
 * ISO/IEC 15948: one IHDR, a `pHYs` for the density, one IDAT of rows with the filter type None, and IEND; the library writes the same
 * filter by default, but also an `iCCP` and an `eXIf` chunk of about 500 bytes and a gray picture as RGB.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIT_DEPTH = 8;
const BIT_DEPTH_1 = 1;
/** PNG colour types (section 11.2.2) of 1, 3 and 4 samples for each pixel. */
const COLOUR_TYPE_BY_CHANNELS = { 1: 0, 3: 2, 4: 6 } as const;
const FILTER_NONE = 0;
const IHDR_DATA_BYTES = 13;
const PHYS_DATA_BYTES = 9;
const PHYS_UNIT_METRE = 1;
const METRES_PER_INCH = 0.0254;
const CHUNK_OVERHEAD_BYTES = 12;

export type PngChannels = keyof typeof COLOUR_TYPE_BY_CHANNELS;

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(CHUNK_OVERHEAD_BYTES + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function finishPng(width: number, height: number, bitDepth: number, colourType: number, rows: Buffer, dpi: number): Buffer {
  const header = Buffer.alloc(IHDR_DATA_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colourType;
  const density = Buffer.alloc(PHYS_DATA_BYTES);
  const pixelsPerMetre = Math.round(dpi / METRES_PER_INCH);
  density.writeUInt32BE(pixelsPerMetre, 0);
  density.writeUInt32BE(pixelsPerMetre, 4);
  density[8] = PHYS_UNIT_METRE;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('pHYs', density), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** The PNG of `samples` (8 bits, `channels` for each pixel, rows in order), or null when the samples are not as many as the size says. */
export function encodePdfPicturePng(width: number, height: number, channels: PngChannels, samples: Uint8Array, dpi: number): Buffer | null {
  const rowBytes = width * channels;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isFinite(dpi) || dpi <= 0 || samples.length !== rowBytes * height) return null;
  const rows = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (rowBytes + 1);
    rows[at] = FILTER_NONE;
    rows.set(samples.subarray(y * rowBytes, (y + 1) * rowBytes), at + 1);
  }
  return finishPng(width, height, BIT_DEPTH, COLOUR_TYPE_BY_CHANNELS[channels], rows, dpi);
}

/**
 * The 1-bit grayscale PNG (colour type 0, bit depth 1) of MSB-first packed `packed` pixels (`0` = black, `1` = white),
 * or null when dimensions, density, or byte count do not match `Math.ceil(width / 8) * height`.
 */
export function encodePdfPicture1BitPng(width: number, height: number, packed: Uint8Array, dpi: number): Buffer | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isFinite(dpi) || dpi <= 0) return null;
  const rowBytes = Math.ceil(width / 8);
  if (packed.length !== rowBytes * height) return null;
  const tailBits = width & 7;
  const tailMask = tailBits === 0 ? 0xff : (0xff << (8 - tailBits)) & 0xff;
  const rows = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (rowBytes + 1);
    rows[at] = FILTER_NONE;
    rows.set(packed.subarray(y * rowBytes, (y + 1) * rowBytes), at + 1);
    if (tailBits !== 0) {
      rows[at + rowBytes] &= tailMask;
    }
  }
  return finishPng(width, height, BIT_DEPTH_1, COLOUR_TYPE_BY_CHANNELS[1], rows, dpi);
}
