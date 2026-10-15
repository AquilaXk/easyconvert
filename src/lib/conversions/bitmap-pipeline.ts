import zlib from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import type { DecodedBmp } from './bmp';
import type { DecodedIcon } from './ico';
import { openInputImage } from './image-input-limits';

/**
 * Turns the RGBA a BMP/ICO decoder produced into an image-library pipeline. Raw pixels carry no colour profile,
 * so a bitmap with an embedded ICC profile (BITMAPV5HEADER) is wrapped in a PNG with that profile as its iCCP
 * chunk (PNG 1.2 section 11.3.3.3); the library then reads it like any profiled picture.
 */

const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_IHDR_DATA_BYTES = 13;
const PNG_CRC_BYTES = 4;
const ICCP_PROFILE_NAME = 'icc';
const ICCP_COMPRESSION_DEFLATE = 0;
const RGBA_CHANNELS = 4;

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(PNG_CHUNK_HEADER_BYTES + data.length + PNG_CRC_BYTES);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, PNG_CHUNK_HEADER_BYTES);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, PNG_CHUNK_HEADER_BYTES + data.length)), PNG_CHUNK_HEADER_BYTES + data.length);
  return out;
}

/** Inserts an iCCP chunk right after the IHDR chunk of `png`. */
function withIccpChunk(png: Buffer, icc: Buffer): Buffer {
  const afterIhdr = PNG_SIGNATURE_BYTES + PNG_CHUNK_HEADER_BYTES + PNG_IHDR_DATA_BYTES + PNG_CRC_BYTES;
  const body = Buffer.concat([
    Buffer.from(`${ICCP_PROFILE_NAME}\0`, 'ascii'),
    Buffer.from([ICCP_COMPRESSION_DEFLATE]),
    zlib.deflateSync(icc),
  ]);
  return Buffer.concat([png.subarray(0, afterIhdr), chunk('iCCP', body), png.subarray(afterIhdr)]);
}

/** A pipeline over the decoded bitmap's pixels, tagged with its ICC profile when it has one. */
export async function pipelineFromBitmap(bitmap: DecodedBmp): Promise<Sharp> {
  const raw = sharp(bitmap.raw, { raw: { width: bitmap.width, height: bitmap.height, channels: RGBA_CHANNELS } });
  if (!bitmap.icc) return raw;
  const png = await raw.png({ compressionLevel: 1 }).toBuffer();
  return openInputImage(withIccpChunk(png, bitmap.icc));
}

/** A pipeline over the image `decodeIco` chose: PNG entries go to the library, DIB entries are already pixels. */
export async function pipelineFromIcon(icon: DecodedIcon): Promise<Sharp> {
  if (icon.kind === 'png') return openInputImage(icon.png);
  return pipelineFromBitmap(icon.bitmap);
}
