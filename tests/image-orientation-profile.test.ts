import { crc32, deflateSync, inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { createMinimalRgbIcc, DISPLAY_P3_ICC } from '../src/lib/conversions/raw-hdr';

/**
 * A PNG whose `eXIf` block says "rotate 90 degrees" and that carries a wide-gamut ICC profile: the picture is turned and the profile
 * is written to a JPEG or WebP exactly as it was in the source. The profile is read back from the file's own container (the APP2
 * segments of a JPEG, the `ICCP` chunk of a WebP) and from the `iCCP` chunk of the source, not through the image library.
 */

const WIDTH = 96;
const HEIGHT = 64;
const NOISE_MULTIPLIER = 2654435761;
const PNG_SIGNATURE_BYTES = 8;
const IHDR_CHUNK_BYTES = 25;
const ICC_SIGNATURE = Buffer.from('ICC_PROFILE\0', 'latin1');
const JPEG_SEGMENT_HEADER_BYTES = 4;
const RIFF_HEADER_BYTES = 12;
const RIFF_CHUNK_HEADER_BYTES = 8;
/**
 * Big-endian TIFF of an `eXIf` chunk as exiftool writes it: IFD0 with Orientation 6 (turn 90 degrees clockwise), a pixel density of
 * 72 per inch (XResolution and YResolution, rationals stored after the directory), ResolutionUnit and YCbCrPositioning.
 */
const EXIF_ORIENTATION_6 = Buffer.from(
  '4d4d002a000000080005011200030000000100060000011a0005000000010000004a011b000500000001000000520128000300000001000200000213000300000001000100000000000000000048000000010000004800000001',
  'hex'
);

/** 16-bit samples: the failure needs a source the library holds as 16-bit RGB. */
function raster(): Uint16Array {
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.imul(i, NOISE_MULTIPLIER) >>> 16;
  return samples;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The `iCCP` chunk of a profile: keyword, 0, compression method 0, deflated profile. */
function profileChunk(profile: Buffer): Buffer {
  return chunk('iCCP', Buffer.concat([Buffer.from('profile\0\0', 'latin1'), deflateSync(profile)]));
}

function withChunkAfterHeader(png: Buffer, extra: Buffer): Buffer {
  const at = PNG_SIGNATURE_BYTES + IHDR_CHUNK_BYTES;
  return Buffer.concat([png.subarray(0, at), extra, png.subarray(at)]);
}

/** The profile of the `iCCP` chunk of a PNG: keyword, 0, method, deflated profile. */
function pngProfile(png: Buffer): Buffer {
  for (let at = PNG_SIGNATURE_BYTES; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'iCCP') {
      const data = png.subarray(at + 8, at + 8 + length);
      return inflateSync(data.subarray(data.indexOf(0) + 2));
    }
    at += length + 12;
  }
  throw new Error('no iCCP chunk');
}

/** The profile split over the APP2 segments of a JPEG ("ICC_PROFILE\0", sequence number, count, bytes). */
function jpegProfile(jpeg: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 2; at + JPEG_SEGMENT_HEADER_BYTES <= jpeg.length && jpeg[at] === 0xff && jpeg[at + 1] !== 0xda; ) {
    const length = jpeg.readUInt16BE(at + 2);
    const body = jpeg.subarray(at + JPEG_SEGMENT_HEADER_BYTES, at + 2 + length);
    if (jpeg[at + 1] === 0xe2 && body.subarray(0, ICC_SIGNATURE.length).equals(ICC_SIGNATURE)) parts.push(body.subarray(ICC_SIGNATURE.length + 2));
    at += 2 + length;
  }
  return Buffer.concat(parts);
}

function webpProfile(webp: Buffer): Buffer {
  for (let at = RIFF_HEADER_BYTES; at + RIFF_CHUNK_HEADER_BYTES <= webp.length; ) {
    const length = webp.readUInt32LE(at + 4);
    if (webp.toString('latin1', at, at + 4) === 'ICCP') return webp.subarray(at + RIFF_CHUNK_HEADER_BYTES, at + RIFF_CHUNK_HEADER_BYTES + length);
    at += RIFF_CHUNK_HEADER_BYTES + length + (length % 2);
  }
  return Buffer.alloc(0);
}

/** A wide-gamut profile of the size of a typical RGB working-space profile (564 bytes, as Adobe RGB (1998) ones are): the length matters to the failure this guards. */
const WORKING_SPACE_ICC = createMinimalRgbIcc('Wide gamut working space profile '.padEnd(142, '.'), {
  r: [0.6097, 0.3111, 0.0195],
  g: [0.2053, 0.6257, 0.0609],
  b: [0.1492, 0.0632, 0.7446],
});

describe('the ICC profile of a picture that is turned by its EXIF orientation', () => {
  it.each([
    ['jpg', jpegProfile, 'Display P3', DISPLAY_P3_ICC],
    ['webp', webpProfile, 'Display P3', DISPLAY_P3_ICC],
    ['jpg', jpegProfile, 'working space', WORKING_SPACE_ICC],
    ['webp', webpProfile, 'working space', WORKING_SPACE_ICC],
  ] as const)('is written to a %s as it is in the source (%s)', async (target, profileOf, _name, iccProfile) => {
    const plain = await sharp(raster(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
    const source = withChunkAfterHeader(plain, Buffer.concat([profileChunk(iccProfile), chunk('eXIf', EXIF_ORIENTATION_6)]));
    expect((await sharp(source).metadata()).depth).toBe('ushort');
    const profile = pngProfile(source);
    expect(profile.equals(iccProfile)).toBe(true);
    expect((await sharp(source).metadata()).orientation).toBe(6);
    const out = (await convertImage(source, target, { quality: 70 }, 'o.png', 'png')).buffer;
    expect((await sharp(out).metadata()).width).toBe(HEIGHT);
    expect(profileOf(out).equals(profile)).toBe(true);
  });
});
