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

/** The PNG of `samples` (8 bits, `channels` for each pixel, rows in order), or null when the samples are not as many as the size says. */
export function encodePdfPicturePng(width: number, height: number, channels: PngChannels, samples: Uint8Array, dpi: number): Buffer | null {
  const rowBytes = width * channels;
  if (width < 1 || height < 1 || samples.length !== rowBytes * height) return null;
  const rows = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (rowBytes + 1);
    rows[at] = FILTER_NONE;
    rows.set(samples.subarray(y * rowBytes, (y + 1) * rowBytes), at + 1);
  }
  const header = Buffer.alloc(IHDR_DATA_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOUR_TYPE_BY_CHANNELS[channels];
  const density = Buffer.alloc(PHYS_DATA_BYTES);
  const pixelsPerMetre = Math.round(dpi / METRES_PER_INCH);
  density.writeUInt32BE(pixelsPerMetre, 0);
  density.writeUInt32BE(pixelsPerMetre, 4);
  density[8] = PHYS_UNIT_METRE;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('pHYs', density), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
