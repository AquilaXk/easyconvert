import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import { DISPLAY_P3_ICC } from '../src/lib/conversions/raw-hdr';
import { buildAnimatedWebpFromStill } from './helpers/webp-builder';
import { buildTiffWithOrientationAndDescription, readExifOrientation } from './helpers/exif-orientation';
import { decodeCoalescedFrames, sampleAt, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * An animated WebP whose frames are oriented one by one keeps its ICC profile and its EXIF block (with the
 * Orientation set to 1) like the orientation-1 path does, and the frames keep the colours they were stored
 * with: a kept profile means the pixels are not converted to sRGB first.
 *
 * Oracles: the animation is assembled by the hand-written WebP builder with a hand-built EXIF block; the
 * output chunks are read with a RIFF scan; frame colours are decoded with ImageMagick, which applies no
 * colour management.
 */

const SIDE = 16;
const FRAMES = 3;
const ROTATED_QUARTER_TURN = 6;
const DESCRIPTION = 'kept description';
/** A mid-gamut colour that a P3 to sRGB conversion would visibly change. */
const FRAME_COLOUR = { r: 200, g: 60, b: 60 };
const COLOUR_TOLERANCE = 6;
const RIFF_HEADER = 12;
const RIFF_CHUNK_HEAD = 8;

function chunksOf(webp: Buffer): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  let pos = RIFF_HEADER;
  while (pos + RIFF_CHUNK_HEAD <= webp.length) {
    const type = webp.toString('latin1', pos, pos + 4);
    const length = webp.readUInt32LE(pos + 4);
    found.set(type, webp.subarray(pos + RIFF_CHUNK_HEAD, pos + RIFF_CHUNK_HEAD + length));
    pos += RIFF_CHUNK_HEAD + length + (length % 2);
  }
  return found;
}

async function profiledAnimation(): Promise<Buffer> {
  const still = await sharp({ create: { width: SIDE, height: SIDE, channels: 3, background: FRAME_COLOUR } })
    .webp({ lossless: true })
    .toBuffer();
  return buildAnimatedWebpFromStill(still, {
    width: SIDE,
    height: SIDE,
    frames: FRAMES,
    icc: DISPLAY_P3_ICC,
    exif: buildTiffWithOrientationAndDescription(ROTATED_QUARTER_TURN, DESCRIPTION),
  });
}

describe('oriented animation metadata', () => {
  it('writes the source ICC profile unchanged and an upright EXIF block that keeps the other tags', async () => {
    const result = await convertImage(await profiledAnimation(), 'webp', { quality: 100 }, 'p3.webp', 'webp');
    const chunks = chunksOf(result.buffer);
    expect(chunks.get('ICCP')?.equals(DISPLAY_P3_ICC)).toBe(true);
    const exif = chunks.get('EXIF');
    expect(exif).toBeDefined();
    expect(exif?.toString('latin1')).toContain(DESCRIPTION);
    expect(readExifOrientation(result.buffer)).toBe(1);
    expect(result.buffer[RIFF_HEADER + RIFF_CHUNK_HEAD] & 0x20).toBe(0x20); // VP8X ICC flag
    expect(result.buffer[RIFF_HEADER + RIFF_CHUNK_HEAD] & 0x08).toBe(0x08); // VP8X EXIF flag
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('does not convert the pixels before attaching the profile', async () => {
    const result = await convertImage(await profiledAnimation(), 'webp', { quality: 100 }, 'p3.webp', 'webp');
    const frames = decodeCoalescedFrames(result.buffer, 'webp');
    expect(frames).toHaveLength(FRAMES);
    const [r, g, b] = sampleAt(frames[0], 4, 4);
    expect(Math.abs(r - FRAME_COLOUR.r)).toBeLessThanOrEqual(COLOUR_TOLERANCE);
    expect(Math.abs(g - FRAME_COLOUR.g)).toBeLessThanOrEqual(COLOUR_TOLERANCE);
    expect(Math.abs(b - FRAME_COLOUR.b)).toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });

  it('strips both when metadata stripping is requested', async () => {
    const result = await convertImage(await profiledAnimation(), 'webp', { stripMetadata: true }, 'p3.webp', 'webp');
    const chunks = chunksOf(result.buffer);
    expect(chunks.has('ICCP')).toBe(false);
    expect(chunks.has('EXIF')).toBe(false);
  });

  it('a gif has nowhere to keep them and is still oriented', async () => {
    const result = await convertImage(await profiledAnimation(), 'gif', {}, 'p3.webp', 'webp');
    expect(result.buffer.toString('latin1', 0, 6)).toBe('GIF89a');
    expect(result.buffer.readUInt16LE(6)).toBe(SIDE);
  });
});
