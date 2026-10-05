import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import {
  countFrames,
  decodeCoalescedFrames,
  decodeRgba,
  frameDelaysMs,
  IMAGEMAGICK_ORIENTATIONS,
  runConvert,
  sampleAt,
  SKIP_WITHOUT_MAGICK,
  type DecodedRgba,
  type Rgb,
} from './helpers/imagemagick';
import { captureError } from './helpers/capture-error';
import { buildApng, readGifLoopCount, readWebpLoopCount } from './helpers/animation-containers';
import { ffprobeFrameCount, SKIP_WITHOUT_FFPROBE } from './helpers/ffprobe-frames';
import { withMissingBinary } from './helpers/native-tools';

/**
 * Animations that sharp cannot orient or read in bulk are decoded frame by frame and reassembled:
 *  - animated WebP with an EXIF orientation 2-8 -> every frame oriented, original delays and loop kept;
 *  - APNG (read by FFmpeg) -> frame 1 for still targets, all frames and delays for gif and webp targets.
 *
 * Oracles: ImageMagick `-coalesce -orient <name> -auto-orient` for the oriented frames, ImageMagick
 * `identify` for frame counts and delays, ffprobe for decoded frame counts, container bytes for loop counts,
 * and a hand-written APNG builder (validated by ffprobe) for the APNG fixtures.
 */

const WIDTH = 30;
const HEIGHT = 20;
const MARKER_WIDTH = 8;
const MARKER_HEIGHT = 6;
const CENTRE_SIZE = 6;
const CORNER_INSET = 2;
const LOOP_COUNT = 3;
const GIF_LOOP_FIELD = LOOP_COUNT - 1;
const DELAYS_CENTISECONDS = [10, 25, 40];
const MS_PER_CENTISECOND = 10;
const EXPECTED_DELAYS_MS = DELAYS_CENTISECONDS.map((value) => value * MS_PER_CENTISECOND);
/** Lossy WebP and GIF palette rounding move flat colours by a few levels. */
const COLOUR_TOLERANCE = 12;
const OPAQUE = 255;
const ORIENTATIONS_NEEDING_PER_FRAME_WORK = [2, 3, 4, 5, 6, 7, 8] as const;

const CENTRE_COLOURS: readonly Rgb[] = [
  [255, 0, 255],
  [0, 255, 255],
  [128, 128, 128],
];
const FRAME_COLOURS: readonly Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

function rgb([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function expectNear(actual: readonly number[], expected: Rgb, label: string): void {
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel] - value), `${label} channel ${channel}: got ${actual[channel]}, expected ${value}`)
      .toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });
}

function cornerSamples(frame: DecodedRgba): number[][] {
  const right = frame.width - 1 - CORNER_INSET;
  const bottom = frame.height - 1 - CORNER_INSET;
  return [
    sampleAt(frame, CORNER_INSET, CORNER_INSET),
    sampleAt(frame, right, CORNER_INSET),
    sampleAt(frame, right, bottom),
    sampleAt(frame, CORNER_INSET, bottom),
  ];
}

/** Three frames with identical red/green/yellow/blue corner markers and a centre block that differs per frame. */
function buildMarkedGif(): Buffer {
  const lastX = WIDTH - 1;
  const lastY = HEIGHT - 1;
  const box = (x: number, y: number, w: number, h: number, colour: string) => [
    '-fill',
    colour,
    '-draw',
    `rectangle ${x},${y} ${x + w - 1},${y + h - 1}`,
  ];
  const args: string[] = [];
  CENTRE_COLOURS.forEach((centre, index) => {
    args.push(
      '(',
      '-delay',
      String(DELAYS_CENTISECONDS[index]),
      '-size',
      `${WIDTH}x${HEIGHT}`,
      'xc:white',
      ...box(0, 0, MARKER_WIDTH, MARKER_HEIGHT, 'rgb(255,0,0)'),
      ...box(lastX - MARKER_WIDTH + 1, 0, MARKER_WIDTH, MARKER_HEIGHT, 'rgb(0,255,0)'),
      ...box(lastX - MARKER_WIDTH + 1, lastY - MARKER_HEIGHT + 1, MARKER_WIDTH, MARKER_HEIGHT, 'rgb(255,255,0)'),
      ...box(0, lastY - MARKER_HEIGHT + 1, MARKER_WIDTH, MARKER_HEIGHT, 'rgb(0,0,255)'),
      ...box((WIDTH - CENTRE_SIZE) / 2, (HEIGHT - CENTRE_SIZE) / 2, CENTRE_SIZE, CENTRE_SIZE, rgb(centre)),
      ')'
    );
  });
  return runConvert([...args, '-loop', String(LOOP_COUNT), 'gif:-']);
}

/** The marked animation as a lossless WebP whose EXIF block asks for `orientation`. */
async function orientedWebp(orientation: number): Promise<Buffer> {
  return sharp(buildMarkedGif(), { animated: true }).withMetadata({ orientation }).webp({ lossless: true }).toBuffer();
}

function expectSameFramesAsReference(actual: DecodedRgba[], reference: DecodedRgba[], label: string): void {
  expect(actual.length, `${label} frame count`).toBe(reference.length);
  actual.forEach((frame, index) => {
    const expected = reference[index];
    expect([frame.width, frame.height], `${label} frame ${index} size`).toEqual([expected.width, expected.height]);
    const actualCorners = cornerSamples(frame);
    cornerSamples(expected).forEach((corner, cornerIndex) => {
      expectNear(actualCorners[cornerIndex], [corner[0], corner[1], corner[2]], `${label} frame ${index} corner ${cornerIndex}`);
    });
    expectNear(
      sampleAt(frame, Math.floor(frame.width / 2), Math.floor(frame.height / 2)),
      CENTRE_COLOURS[index],
      `${label} frame ${index} centre`
    );
  });
}

describe('animated WebP with an EXIF orientation', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK).each(ORIENTATIONS_NEEDING_PER_FRAME_WORK)(
    'orientation %i: every frame of the gif output is oriented, in order, with the original delays and loop',
    async (orientation) => {
      const source = await orientedWebp(orientation);
      const reference = decodeCoalescedFrames(source, 'webp', IMAGEMAGICK_ORIENTATIONS[orientation - 1]);
      expect(reference).toHaveLength(CENTRE_COLOURS.length);
      const result = await convertImage(source, 'gif', {}, 'anim.webp', 'webp');
      expect(countFrames(result.buffer, 'gif')).toBe(CENTRE_COLOURS.length);
      expect(frameDelaysMs(result.buffer, 'gif')).toEqual(EXPECTED_DELAYS_MS);
      expect(readGifLoopCount(result.buffer)).toBe(GIF_LOOP_FIELD);
      expectSameFramesAsReference(decodeCoalescedFrames(result.buffer, 'gif'), reference, `gif orientation ${orientation}`);
      expect(result.sourceFrameCount).toBe(CENTRE_COLOURS.length);
      expect(result.frameUsed).toBeUndefined();
    }
  );

  it.skipIf(SKIP_WITHOUT_MAGICK).each([3, 6, 8])(
    'orientation %i: the webp output is oriented per frame with delays and loop kept',
    async (orientation) => {
      const source = await orientedWebp(orientation);
      const reference = decodeCoalescedFrames(source, 'webp', IMAGEMAGICK_ORIENTATIONS[orientation - 1]);
      const result = await convertImage(source, 'webp', { quality: 100 }, 'anim.webp', 'webp');
      expect(countFrames(result.buffer, 'webp')).toBe(CENTRE_COLOURS.length);
      expect(frameDelaysMs(result.buffer, 'webp')).toEqual(EXPECTED_DELAYS_MS);
      expect(readWebpLoopCount(result.buffer)).toBe(LOOP_COUNT);
      expectSameFramesAsReference(decodeCoalescedFrames(result.buffer, 'webp'), reference, `webp orientation ${orientation}`);
    }
  );

  it.skipIf(SKIP_WITHOUT_MAGICK)('resizes the oriented frames from their oriented size', async () => {
    const source = await orientedWebp(6);
    const result = await convertImage(source, 'gif', { width: 10 }, 'anim.webp', 'webp');
    const frames = decodeCoalescedFrames(result.buffer, 'gif');
    // Oriented frames are 20x30; width 10 keeps the aspect ratio and gives height 15 (stored 30x20 would give 7).
    expect(frames.map((frame) => [frame.width, frame.height])).toEqual(CENTRE_COLOURS.map(() => [10, 15]));
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a still target takes the oriented frame 1 and reports it', async () => {
    const source = await orientedWebp(6);
    const reference = decodeCoalescedFrames(source, 'webp', IMAGEMAGICK_ORIENTATIONS[5]);
    const result = await convertImage(source, 'png', {}, 'anim.webp', 'webp');
    const frame = decodeRgba(result.buffer, 'png');
    expect([frame.width, frame.height]).toEqual([reference[0].width, reference[0].height]);
    expectNear(cornerSamples(frame)[0], [cornerSamples(reference[0])[0][0], cornerSamples(reference[0])[0][1], cornerSamples(reference[0])[0][2]], 'frame 1 top-left');
    expect(result.sourceFrameCount).toBe(CENTRE_COLOURS.length);
    expect(result.frameUsed).toBe(1);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('rejects custom quantizers that cannot work frame by frame', async () => {
    const error = await captureError(async () =>
      convertImage(await orientedWebp(6), 'gif', { quantizer: 'oklab' }, 'anim.webp', 'webp')
    );
    expect(error.name).toBe('UnsupportedOptionError');
  });
});

describe('animated PNG (APNG) sources', () => {
  const APNG_DELAYS_CS = [10, 25];
  const APNG_PLAYS = 0;

  function buildTwoFrameApng(plays = APNG_PLAYS): Buffer {
    const still = (colour: Rgb) => runConvert(['-size', `${WIDTH}x${HEIGHT}`, `xc:${rgb(colour)}`, 'png24:-']);
    return buildApng([still(FRAME_COLOURS[0]), still(FRAME_COLOURS[1])], APNG_DELAYS_CS, plays);
  }

  it.skipIf(SKIP_WITHOUT_MAGICK || SKIP_WITHOUT_FFPROBE)('the fixture is a real two-frame APNG', () => {
    expect(ffprobeFrameCount(buildTwoFrameApng(), 'apng')).toBe(2);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each(['png', 'jpg'])('%s output defaults to frame 1 and reports it', async (target) => {
    const result = await convertImage(buildTwoFrameApng(), target, {}, 'anim.png', 'png');
    expect(result.sourceFrameCount).toBe(2);
    expect(result.frameUsed).toBe(1);
    expectNear(sampleAt(decodeRgba(result.buffer, target), WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[0], 'frame 1');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page 2 selects the second frame', async () => {
    const result = await convertImage(buildTwoFrameApng(), 'png', { page: 2 }, 'anim.png', 'png');
    expect(result.frameUsed).toBe(2);
    expectNear(sampleAt(decodeRgba(result.buffer, 'png'), WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[1], 'frame 2');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page 3 is outside 1..2 and is rejected', async () => {
    const error = await captureError(() => convertImage(buildTwoFrameApng(), 'png', { page: 3 }, 'anim.png', 'png'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toMatch(/out of range: the image has 2 frames/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK || SKIP_WITHOUT_FFPROBE)('gif output keeps both frames, their delays and the loop', async () => {
    const result = await convertImage(buildTwoFrameApng(), 'gif', {}, 'anim.png', 'png');
    expect(ffprobeFrameCount(result.buffer, 'gif')).toBe(2);
    expect(countFrames(result.buffer, 'gif')).toBe(2);
    expect(frameDelaysMs(result.buffer, 'gif')).toEqual(APNG_DELAYS_CS.map((value) => value * MS_PER_CENTISECOND));
    expect(readGifLoopCount(result.buffer)).toBe(0);
    const frames = decodeCoalescedFrames(result.buffer, 'gif');
    expectNear(sampleAt(frames[0], WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[0], 'gif frame 1');
    expectNear(sampleAt(frames[1], WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[1], 'gif frame 2');
    expect(result.sourceFrameCount).toBe(2);
    expect(result.frameUsed).toBeUndefined();
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('webp output keeps both frames, their delays and a finite loop', async () => {
    const plays = 2;
    const result = await convertImage(buildTwoFrameApng(plays), 'webp', { quality: 100 }, 'anim.png', 'png');
    // ffprobe's WebP demuxer does not report decoded frame counts, so ImageMagick counts the frames here.
    expect(countFrames(result.buffer, 'webp')).toBe(2);
    expect(frameDelaysMs(result.buffer, 'webp')).toEqual(APNG_DELAYS_CS.map((value) => value * MS_PER_CENTISECOND));
    expect(readWebpLoopCount(result.buffer)).toBe(plays);
    const frames = decodeCoalescedFrames(result.buffer, 'webp');
    expectNear(sampleAt(frames[0], WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[0], 'webp frame 1');
    expectNear(sampleAt(frames[1], WIDTH / 2, HEIGHT / 2), FRAME_COLOURS[1], 'webp frame 2');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('frame 1 of a still target needs no FFmpeg', async () => {
    const result = await withMissingBinary('FFMPEG_PATH', () => convertImage(buildTwoFrameApng(), 'png', {}, 'anim.png', 'png'));
    expect(result.frameUsed).toBe(1);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each([
    ['gif target', 'gif', {}],
    ['webp target', 'webp', {}],
    ['page 2', 'png', { page: 2 }],
  ])('%s without FFmpeg throws EngineUnavailableError', async (_label, target, options) => {
    const error = await captureError(() =>
      withMissingBinary('FFMPEG_PATH', () => convertImage(buildTwoFrameApng(), target, options, 'anim.png', 'png'))
    );
    expect(error.name).toBe('EngineUnavailableError');
    expect(error.message).toMatch(/Engine 'ffmpeg' is unavailable/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a truncated frame control table is rejected as malformed', async () => {
    const apng = buildTwoFrameApng();
    const actl = apng.indexOf('acTL', 0, 'latin1');
    const forged = Buffer.from(apng);
    forged.writeUInt32BE(5, actl + 4); // announce five frames while only two fcTL chunks exist
    const error = await captureError(() => convertImage(forged, 'png', {}, 'anim.png', 'png'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/Malformed animated PNG: acTL announces 5 frames but 2 frame control chunks/);
  });
});
