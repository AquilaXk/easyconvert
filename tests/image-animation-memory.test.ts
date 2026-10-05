import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import { ApngCompositor, parseApng } from '../src/lib/conversions/image-apng';
import { MAX_ANIMATION_FRAMES } from '../src/lib/conversions/image-limits';
import { buildApngFile, rgbaImage, type ApngSpec } from './helpers/apng-builder';
import { buildAnimatedWebpFromStill } from './helpers/webp-builder';
import { captureError } from './helpers/capture-error';
import { buildTinyGif } from './helpers/gif-builder';
import { countFrames, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * The animation budget counts the frame-sized buffers alive at once, not only the frames: composing an
 * APNG holds the canvas, the decoded frame and the encoder's copy, so two 8000 x 8000 frames (which measured
 * at about 1.5 GB) are refused while a canvas that fits comfortably is accepted. An animation also has a frame
 * limit, whatever its size, for every target.
 *
 * Oracles: the animations are written by the hand-built APNG and WebP writers and by ImageMagick; the
 * limits are the documented constants.
 */

const BUDGET = /decoded animation limit/;
const FRAME_LIMIT = new RegExp(`over the limit of ${MAX_ANIMATION_FRAMES} frames`);
const OVER_FRAME_LIMIT = MAX_ANIMATION_FRAMES + 1;
const HUGE_CANVAS = 8000;
const COMFORTABLE_CANVAS = 5000;
const OPAQUE_PIXEL = [10, 20, 30, 255] as const;

/** An APNG whose header announces a big canvas but whose frame data is a single pixel (never decoded when refused). */
function forgedCanvasApng(side: number): Buffer {
  const pixel = rgbaImage(1, 1, () => OPAQUE_PIXEL);
  const spec: ApngSpec = { width: side, height: side, frames: [{ image: pixel }, { image: pixel }] };
  return buildApngFile(spec, (chunks) => {
    const first = chunks.find((chunk) => chunk.type === 'fcTL')!;
    first.data.writeUInt32BE(side, 4);
    first.data.writeUInt32BE(side, 8);
  });
}

describe('working-set accounting', () => {
  it('refuses two 8000x8000 frames: 512 MiB of frames would need 1.5 GiB at its peak', async () => {
    const error = await captureError(() => convertImage(forgedCanvasApng(HUGE_CANVAS), 'gif', {}, 'big.png', 'png'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(BUDGET);
    expect(error.message).toContain(`2 frames of ${HUGE_CANVAS}x${HUGE_CANVAS}`);
    expect(error.message).toContain('MiB as RGBA at its peak');
  });

  it('refuses a single 8000x8000 frame as a still too, since canvas, decode and encode copies coexist', async () => {
    const error = await captureError(() => convertImage(forgedCanvasApng(HUGE_CANVAS), 'png', { page: 2 }, 'big.png', 'png'));
    expect(error.message).toMatch(BUDGET);
  });

  it('lets a 5000x5000 canvas past the budget (it then fails on the forged frame data, not on memory)', async () => {
    const error = await captureError(() => convertImage(forgedCanvasApng(COMFORTABLE_CANVAS), 'gif', {}, 'big.png', 'png'));
    expect(error.message).not.toMatch(BUDGET);
    expect(error.message).toMatch(/Malformed animated PNG/);
  });
});

describe('the compositor hands out its canvas without copying it', () => {
  it('serves each frame from the same buffer, valid until the next frame is drawn', async () => {
    const red = rgbaImage(4, 4, () => [255, 0, 0, 255]);
    const green = rgbaImage(4, 4, () => [0, 255, 0, 255]);
    const apng = parseApng(buildApngFile({ width: 4, height: 4, frames: [{ image: red }, { image: green }] }));
    expect(apng).not.toBeNull();
    const compositor = new ApngCompositor(apng!);
    await compositor.advance();
    const first = compositor.snapshot();
    expect(Array.from(first.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    await compositor.advance();
    const second = compositor.snapshot();
    expect(second).toBe(first);
    expect(Array.from(second.subarray(0, 4))).toEqual([0, 255, 0, 255]);
  });
});

describe('frame limit', () => {
  const tinyApng = (frames: number) => {
    const pixel = rgbaImage(1, 1, () => OPAQUE_PIXEL);
    return buildApngFile({ width: 1, height: 1, frames: Array.from({ length: frames }, () => ({ image: pixel })) });
  };

  it.each(['gif', 'webp', 'png'])('an APNG with more frames than the limit is refused for a %s target', async (target) => {
    const error = await captureError(() => convertImage(tinyApng(OVER_FRAME_LIMIT), target, {}, 'many.png', 'png'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(FRAME_LIMIT);
    expect(error.message).toContain(`${OVER_FRAME_LIMIT} frames`);
  });

  it('an APNG within the limit converts', async () => {
    const result = await convertImage(tinyApng(3), 'png', { page: 2 }, 'few.png', 'png');
    expect(result.sourceFrameCount).toBe(3);
  });

  it.each(['gif', 'webp', 'png'])('a WebP with more frames than the limit is refused for a %s target', async (target) => {
    const still = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .webp({ lossless: true })
      .toBuffer();
    const animation = buildAnimatedWebpFromStill(still, { width: 2, height: 2, frames: OVER_FRAME_LIMIT });
    const error = await captureError(() => convertImage(animation, target, {}, 'many.webp', 'webp'));
    expect(error.message).toMatch(FRAME_LIMIT);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('the hand-built GIF fixture really has the frames it claims', () => {
    expect(countFrames(buildTinyGif(OVER_FRAME_LIMIT), 'gif')).toBe(OVER_FRAME_LIMIT);
  });

  it.each(['gif', 'png'])('a GIF with more frames than the limit is refused for a %s target', async (target) => {
    const error = await captureError(() => convertImage(buildTinyGif(OVER_FRAME_LIMIT), target, {}, 'many.gif', 'gif'));
    expect(error.message).toMatch(FRAME_LIMIT);
  });

  it('a GIF at the limit converts to a still', async () => {
    const result = await convertImage(buildTinyGif(MAX_ANIMATION_FRAMES), 'png', { page: 2 }, 'edge.gif', 'gif');
    expect(result.sourceFrameCount).toBe(MAX_ANIMATION_FRAMES);
    expect(result.frameUsed).toBe(2);
  });
});
