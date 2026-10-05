import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import {
  countFrames,
  decodeCoalescedFrames,
  decodeRgba,
  frameDelaysMs,
  runConvert,
  sampleAt,
  SKIP_WITHOUT_MAGICK,
  type DecodedRgba,
  type Rgb,
} from './helpers/imagemagick';
import { captureError } from './helpers/capture-error';
import { buildApng, readGifLoopCount, readWebpLoopCount } from './helpers/animation-containers';
import { injectExifOrientation } from './helpers/exif-orientation';

/**
 * Animated GIF and WebP sources must keep every frame, each frame delay and the loop count when the target
 * can animate; a still target needs an explicit `page` (1-based frame number) and otherwise fails closed.
 *
 * Oracles: fixtures are written by ImageMagick (and a hand-written APNG builder); frame counts, delays and
 * composited frame pixels are read back with ImageMagick, and loop counts from the container bytes.
 */

const FRAME_WIDTH = 30;
const FRAME_HEIGHT = 20;
const LOOP_COUNT = 3;
/** The GIF NETSCAPE2.0 field counts repeats after the first play, so three plays are stored as 2. */
const GIF_LOOP_FIELD = LOOP_COUNT - 1;
/** Frame delays in hundredths of a second, as GIF stores them. */
const DELAYS_CENTISECONDS = [10, 25, 40];
const MS_PER_CENTISECOND = 10;
const EXPECTED_DELAYS_MS = DELAYS_CENTISECONDS.map((value) => value * MS_PER_CENTISECOND);
const FRAME_COLOURS: readonly Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];
/** Lossy WebP and GIF palette rounding move flat colours by a few levels. */
const COLOUR_TOLERANCE = 12;
const OPAQUE = 255;
const STILL_TARGETS = ['png', 'jpg', 'bmp', 'tiff', 'avif', 'ico', 'psd'] as const;

function rgb([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function buildAnimatedGif(): Buffer {
  const args = ['-size', `${FRAME_WIDTH}x${FRAME_HEIGHT}`];
  FRAME_COLOURS.forEach((colour, index) => {
    args.push('-delay', String(DELAYS_CENTISECONDS[index]), `xc:${rgb(colour)}`);
  });
  return runConvert([...args, '-loop', String(LOOP_COUNT), 'gif:-']);
}

function buildAnimatedWebp(gif: Buffer): Buffer {
  return runConvert(['gif:-', '-define', 'webp:lossless=true', 'webp:-'], gif);
}

function expectFrameColour(frame: DecodedRgba, expected: Rgb, label: string): void {
  const [r, g, b, a] = sampleAt(frame, Math.floor(frame.width / 2), Math.floor(frame.height / 2));
  [r, g, b].forEach((value, channel) => {
    expect(Math.abs(value - expected[channel]), `${label} channel ${channel}: got ${value}, expected ${expected[channel]}`)
      .toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });
  expect(a, `${label} alpha`).toBe(OPAQUE);
}

describe('fixtures', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('the animated GIF fixture really has three delayed, looping frames', () => {
    const gif = buildAnimatedGif();
    expect(countFrames(gif, 'gif')).toBe(FRAME_COLOURS.length);
    expect(frameDelaysMs(gif, 'gif')).toEqual(EXPECTED_DELAYS_MS);
    expect(readGifLoopCount(gif)).toBe(GIF_LOOP_FIELD);
  });
});

describe('convertImage keeps animation for animated targets', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('gif to gif keeps every frame, delay and the loop count', async () => {
    const result = await convertImage(buildAnimatedGif(), 'gif', {}, 'anim.gif', 'gif');
    expect(countFrames(result.buffer, 'gif')).toBe(FRAME_COLOURS.length);
    expect(frameDelaysMs(result.buffer, 'gif')).toEqual(EXPECTED_DELAYS_MS);
    expect(readGifLoopCount(result.buffer)).toBe(GIF_LOOP_FIELD);
    const frames = decodeCoalescedFrames(result.buffer, 'gif');
    expect(frames.map((frame) => [frame.width, frame.height])).toEqual(FRAME_COLOURS.map(() => [FRAME_WIDTH, FRAME_HEIGHT]));
    frames.forEach((frame, index) => expectFrameColour(frame, FRAME_COLOURS[index], `gif frame ${index}`));
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('gif to webp keeps every frame, delay and the loop count', async () => {
    const result = await convertImage(buildAnimatedGif(), 'webp', { quality: 100 }, 'anim.gif', 'gif');
    expect(result.buffer.toString('latin1', 8, 12)).toBe('WEBP');
    expect(countFrames(result.buffer, 'webp')).toBe(FRAME_COLOURS.length);
    expect(frameDelaysMs(result.buffer, 'webp')).toEqual(EXPECTED_DELAYS_MS);
    expect(readWebpLoopCount(result.buffer)).toBe(LOOP_COUNT);
    const frames = decodeCoalescedFrames(result.buffer, 'webp');
    frames.forEach((frame, index) => expectFrameColour(frame, FRAME_COLOURS[index], `webp frame ${index}`));
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('animated webp to gif keeps every frame and delay', async () => {
    const webp = buildAnimatedWebp(buildAnimatedGif());
    expect(countFrames(webp, 'webp')).toBe(FRAME_COLOURS.length);
    const sourceDelays = frameDelaysMs(webp, 'webp');
    const result = await convertImage(webp, 'gif', {}, 'anim.webp', 'webp');
    expect(countFrames(result.buffer, 'gif')).toBe(FRAME_COLOURS.length);
    expect(frameDelaysMs(result.buffer, 'gif')).toEqual(sourceDelays);
    decodeCoalescedFrames(result.buffer, 'gif').forEach((frame, index) =>
      expectFrameColour(frame, FRAME_COLOURS[index], `gif frame ${index}`)
    );
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('resizes every frame of an animated gif', async () => {
    const width = 15;
    const result = await convertImage(buildAnimatedGif(), 'gif', { width, height: 10, fit: 'fill' }, 'anim.gif', 'gif');
    const frames = decodeCoalescedFrames(result.buffer, 'gif');
    expect(frames.map((frame) => [frame.width, frame.height])).toEqual(FRAME_COLOURS.map(() => [width, 10]));
    expect(frameDelaysMs(result.buffer, 'gif')).toEqual(EXPECTED_DELAYS_MS);
    frames.forEach((frame, index) => expectFrameColour(frame, FRAME_COLOURS[index], `resized frame ${index}`));
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('refuses a custom quantizer that would collapse the frames of an animated gif', async () => {
    const error = await captureError(() =>
      convertImage(buildAnimatedGif(), 'gif', { quantizer: 'oklab' }, 'anim.gif', 'gif')
    );
    expect(error.name).toBe('UnsupportedOptionError');
    expect(error.message).toMatch(/cannot be applied to an animated GIF/);
  });
});

describe('convertImage with a still target', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK).each(STILL_TARGETS)(
    '%s output of an animated gif defaults to frame 1 and reports the frame counts',
    async (target) => {
      const result = await convertImage(buildAnimatedGif(), target, {}, 'anim.gif', 'gif');
      expect(result.sourceFrameCount).toBe(FRAME_COLOURS.length);
      expect(result.frameUsed).toBe(1);
      if (target === 'psd') {
        // The pixel oracle cannot open this PSD's layer layout; the signature proves the format.
        expect(result.buffer.toString('latin1', 0, 4)).toBe('8BPS');
        return;
      }
      expect(countFrames(result.buffer, target)).toBe(1);
      expectFrameColour(decodeRgba(result.buffer, target), FRAME_COLOURS[0], `${target} frame 1`);
    }
  );

  it.skipIf(SKIP_WITHOUT_MAGICK)('png output of an animated webp defaults to frame 1', async () => {
    const result = await convertImage(buildAnimatedWebp(buildAnimatedGif()), 'png', {}, 'anim.webp', 'webp');
    expect(result.sourceFrameCount).toBe(FRAME_COLOURS.length);
    expect(result.frameUsed).toBe(1);
    expectFrameColour(decodeRgba(result.buffer, 'png'), FRAME_COLOURS[0], 'webp frame 1');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each([1, 2, 3])('page %i selects exactly that frame', async (page) => {
    const result = await convertImage(buildAnimatedGif(), 'png', { page }, 'anim.gif', 'gif');
    expect(countFrames(result.buffer, 'png')).toBe(1);
    expect(result.sourceFrameCount).toBe(FRAME_COLOURS.length);
    expect(result.frameUsed).toBe(page);
    const frame = decodeRgba(result.buffer, 'png');
    expect([frame.width, frame.height]).toEqual([FRAME_WIDTH, FRAME_HEIGHT]);
    expectFrameColour(frame, FRAME_COLOURS[page - 1], `page ${page}`);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('pages naming a single frame selects it, as the API sends page as pages', async () => {
    const result = await convertImage(buildAnimatedGif(), 'png', { pages: '2' }, 'anim.gif', 'gif');
    expect(result.frameUsed).toBe(2);
    expectFrameColour(decodeRgba(result.buffer, 'png'), FRAME_COLOURS[1], 'pages 2');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('pages naming several frames is rejected for a still image', async () => {
    const error = await captureError(() => convertImage(buildAnimatedGif(), 'png', { pages: '1-2' }, 'anim.gif', 'gif'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/Select a single frame of this 3-frame image/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page selects one frame of an animated webp too', async () => {
    const result = await convertImage(buildAnimatedWebp(buildAnimatedGif()), 'png', { page: 3 }, 'anim.webp', 'webp');
    expect(result.frameUsed).toBe(3);
    expectFrameColour(decodeRgba(result.buffer, 'png'), FRAME_COLOURS[2], 'webp page 3');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page on an animated target yields a single still frame', async () => {
    const result = await convertImage(buildAnimatedGif(), 'webp', { page: 2, quality: 100 }, 'anim.gif', 'gif');
    expect(countFrames(result.buffer, 'webp')).toBe(1);
    expect(result.frameUsed).toBe(2);
    expectFrameColour(decodeRgba(result.buffer, 'webp'), FRAME_COLOURS[1], 'webp page 2');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each([0, 4, -1])('page %s is outside 1..3 and is rejected', async (page) => {
    const error = await captureError(() => convertImage(buildAnimatedGif(), 'png', { page }, 'anim.gif', 'gif'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/out of range: the image has 3 frames/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('an animated target keeps every frame and reports only the frame count', async () => {
    const result = await convertImage(buildAnimatedGif(), 'gif', {}, 'anim.gif', 'gif');
    expect(result.sourceFrameCount).toBe(FRAME_COLOURS.length);
    expect(result.frameUsed).toBeUndefined();
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a single-frame gif converts to png without frame metadata', async () => {
    const single = runConvert(['-size', `${FRAME_WIDTH}x${FRAME_HEIGHT}`, `xc:${rgb(FRAME_COLOURS[0])}`, 'gif:-']);
    const result = await convertImage(single, 'png', {}, 'still.gif', 'gif');
    expectFrameColour(decodeRgba(result.buffer, 'png'), FRAME_COLOURS[0], 'still gif');
    expect(result.sourceFrameCount).toBeUndefined();
    expect(result.frameUsed).toBeUndefined();
  });
});
