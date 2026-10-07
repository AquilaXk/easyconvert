import { describe, it, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { parseApng } from '../src/lib/conversions/image-apng';
import {
  COLOUR_TYPE,
  buildApngFile,
  encodePng,
  rgbaImage,
  type ApngSpec,
  type Chunk,
  type PngImage,
} from './helpers/apng-builder';
import { SKIP_WITHOUT_FFMPEG, decodeFramesWithFfmpeg } from './helpers/ffmpeg-apng';
import {
  countFrames,
  decodeCoalescedFrames,
  decodeRgba,
  frameDelaysMs,
  SKIP_WITHOUT_MAGICK,
  sampleAt,
  type DecodedRgba,
} from './helpers/imagemagick';
import { readGifLoopCount } from './helpers/animation-containers';
import { captureError } from './helpers/capture-error';
import { withMissingBinary } from './helpers/native-tools';

/**
 * Animated PNG sources are decoded in process: every chunk is CRC-checked, fcTL/fdAT sequence numbers must
 * run 0, 1, 2 ..., frame regions must fit the canvas, and the frames are composited with the dispose and
 * blend operations of the APNG 1.0 specification.
 *
 * Oracles: the files are written by the hand-built writer in tests/helpers/apng-builder.ts (own CRC table);
 * composited frames are compared with FFmpeg's APNG decoder; GIF/WebP output is read back with ImageMagick.
 */

const CANVAS_WIDTH = 16;
const CANVAS_HEIGHT = 12;
/** 8-bit blending rounds differently in each implementation. */
const BLEND_TOLERANCE = 3;
const OPAQUE = 255;
const HALF_ALPHA = 128;
const MALFORMED = /Malformed animated PNG/;

const DISPOSE_NONE = 0;
const DISPOSE_BACKGROUND = 1;
const DISPOSE_PREVIOUS = 2;
const BLEND_SOURCE = 0;
const BLEND_OVER = 1;

const solid = (width: number, height: number, rgba: readonly [number, number, number, number]): PngImage =>
  rgbaImage(width, height, () => rgba);

/** Five frames exercising every dispose and blend operation with sub-rectangles and partial alpha. */
function matrixSpec(): ApngSpec {
  return {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    plays: 0,
    frames: [
      {
        image: rgbaImage(CANVAS_WIDTH, CANVAS_HEIGHT, (x, y) => [x * 16, y * 20, (x * y) & 255, OPAQUE]),
        dispose: DISPOSE_NONE,
        blend: BLEND_SOURCE,
        delayNum: 1,
        delayDen: 10,
      },
      { image: solid(8, 6, [255, 0, 0, HALF_ALPHA]), x: 4, y: 3, dispose: DISPOSE_BACKGROUND, blend: BLEND_OVER, delayNum: 3, delayDen: 100 },
      { image: solid(6, 6, [0, 255, 0, 100]), x: 2, y: 2, dispose: DISPOSE_PREVIOUS, blend: BLEND_SOURCE, delayNum: 2, delayDen: 0 },
      { image: solid(5, 5, [0, 0, 255, 200]), x: 9, y: 5, dispose: DISPOSE_NONE, blend: BLEND_OVER, delayNum: 1, delayDen: 4 },
      {
        image: rgbaImage(CANVAS_WIDTH, 4, (x) => (x % 2 === 0 ? [255, 255, 0, 255] : [0, 0, 0, 0])),
        y: 8,
        dispose: DISPOSE_BACKGROUND,
        blend: BLEND_OVER,
        delayNum: 10,
        delayDen: 1000,
      },
    ],
  };
}

function expectSameComposite(actual: DecodedRgba, expected: Buffer, label: string): void {
  expect([actual.width, actual.height], `${label} size`).toEqual([CANVAS_WIDTH, CANVAS_HEIGHT]);
  for (let pixel = 0; pixel < CANVAS_WIDTH * CANVAS_HEIGHT; pixel += 1) {
    const at = pixel * 4;
    expect(Math.abs(actual.data[at + 3] - expected[at + 3]), `${label} pixel ${pixel} alpha`).toBeLessThanOrEqual(BLEND_TOLERANCE);
    if (expected[at + 3] === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      expect(
        Math.abs(actual.data[at + channel] - expected[at + channel]),
        `${label} pixel ${pixel} channel ${channel}: got ${actual.data[at + channel]}, expected ${expected[at + channel]}`
      ).toBeLessThanOrEqual(BLEND_TOLERANCE);
    }
  }
}

describe('APNG compositing (dispose and blend operations)', () => {
  const apng = () => buildApngFile(matrixSpec());

  it.skipIf(SKIP_WITHOUT_MAGICK || SKIP_WITHOUT_FFMPEG).each([1, 2, 3, 4, 5])(
    'page %i equals the frame FFmpeg composites',
    async (page) => {
      const reference = decodeFramesWithFfmpeg(apng(), 'apng', CANVAS_WIDTH, CANVAS_HEIGHT);
      expect(reference.frames).toHaveLength(5);
      const result = await convertImage(apng(), 'png', { page }, 'anim.png', 'png');
      expect(result.sourceFrameCount).toBe(5);
      expect(result.frameUsed).toBe(page);
      expectSameComposite(decodeRgba(result.buffer, 'png'), reference.frames[page - 1], `page ${page}`);
    }
  );

  it.skipIf(SKIP_WITHOUT_MAGICK || SKIP_WITHOUT_FFMPEG)('a gif output keeps every composited frame, delay and the infinite loop', async () => {
    const reference = decodeFramesWithFfmpeg(apng(), 'apng', CANVAS_WIDTH, CANVAS_HEIGHT);
    const result = await convertImage(apng(), 'gif', {}, 'anim.png', 'png');
    expect(countFrames(result.buffer, 'gif')).toBe(5);
    // 1/10 s, 3/100 s, 2/(den 0 means 100) s, 1/4 s, 5/1000 s in milliseconds; GIF stores whole centiseconds.
    expect(frameDelaysMs(result.buffer, 'gif')).toEqual([100, 30, 20, 250, 10]);
    expect(readGifLoopCount(result.buffer)).toBe(0);
    const frames = decodeCoalescedFrames(result.buffer, 'gif');
    expect(frames).toHaveLength(5);
    frames.forEach((frame, index) => {
      // GIF has one transparent index and a 256-colour palette: compare the alpha mask and loose colour.
      for (let pixel = 0; pixel < CANVAS_WIDTH * CANVAS_HEIGHT; pixel += 1) {
        const at = pixel * 4;
        const wantsVisible = reference.frames[index][at + 3] >= HALF_ALPHA;
        const wantsHidden = reference.frames[index][at + 3] === 0;
        if (wantsVisible) expect(frame.data[at + 3], `gif frame ${index} pixel ${pixel}`).toBe(OPAQUE);
        if (wantsHidden) expect(frame.data[at + 3], `gif frame ${index} pixel ${pixel}`).toBe(0);
      }
    });
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a webp output keeps every frame and delay', async () => {
    const result = await convertImage(apng(), 'webp', { quality: 100 }, 'anim.png', 'png');
    expect(countFrames(result.buffer, 'webp')).toBe(5);
    expect(frameDelaysMs(result.buffer, 'webp')).toEqual([100, 30, 20, 250, 10]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('needs no FFmpeg to decode', async () => {
    const result = await withMissingBinary('FFMPEG_PATH', () => convertImage(apng(), 'gif', {}, 'anim.png', 'png'));
    expect(countFrames(result.buffer, 'gif')).toBe(5);
    const still = await withMissingBinary('FFMPEG_PATH', () => convertImage(apng(), 'png', { page: 4 }, 'anim.png', 'png'));
    expect(still.frameUsed).toBe(4);
  });
});

describe('APNG default image', () => {
  const MAGENTA: readonly [number, number, number, number] = [255, 0, 255, 255];
  const frameColours: ReadonlyArray<readonly [number, number, number, number]> = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ];
  const hiddenSpec = (): ApngSpec => ({
    width: 8,
    height: 8,
    hiddenDefault: solid(8, 8, MAGENTA),
    frames: frameColours.map((colour) => ({ image: solid(8, 8, colour) })),
  });
  const centre = (image: DecodedRgba) => sampleAt(image, 4, 4);

  it.skipIf(SKIP_WITHOUT_MAGICK)('a default image outside the animation is the still result when no page is given', async () => {
    const result = await convertImage(buildApngFile(hiddenSpec()), 'png', {}, 'anim.png', 'png');
    expect(centre(decodeRgba(result.buffer, 'png'))).toEqual([...MAGENTA]);
    expect(result.sourceFrameCount).toBe(3);
    expect(result.frameUsed).toBeUndefined();
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each([1, 2, 3])('page %i selects animation frame %i, not the default image', async (page) => {
    const result = await convertImage(buildApngFile(hiddenSpec()), 'png', { page }, 'anim.png', 'png');
    expect(centre(decodeRgba(result.buffer, 'png'))).toEqual([...frameColours[page - 1]]);
    expect(result.frameUsed).toBe(page);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('an animated target excludes the default image', async () => {
    const result = await convertImage(buildApngFile(hiddenSpec()), 'gif', {}, 'anim.png', 'png');
    expect(countFrames(result.buffer, 'gif')).toBe(3);
    const frames = decodeCoalescedFrames(result.buffer, 'gif');
    frames.forEach((frame, index) => {
      const [r, g, b] = centre(frame);
      expect([r, g, b]).toEqual(frameColours[index].slice(0, 3));
    });
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('frame 1 is the default image when an fcTL precedes the IDAT', async () => {
    const spec: ApngSpec = { width: 8, height: 8, frames: frameColours.map((colour) => ({ image: solid(8, 8, colour) })) };
    const result = await convertImage(buildApngFile(spec), 'png', {}, 'anim.png', 'png');
    expect(centre(decodeRgba(result.buffer, 'png'))).toEqual([...frameColours[0]]);
    expect(result.frameUsed).toBe(1);
  });
});

describe('the full-canvas rule applies to the default image only', () => {
  const CANVAS = 8;
  const TEAL: readonly [number, number, number, number] = [0, 128, 128, 255];
  const hiddenWithSmallFirstFrame = (): ApngSpec => ({
    width: CANVAS,
    height: CANVAS,
    hiddenDefault: solid(CANVAS, CANVAS, [255, 0, 255, 255]),
    frames: [
      { image: solid(4, 4, TEAL), x: 2, y: 2 },
      { image: solid(8, 8, [255, 128, 0, 255]) },
    ],
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a first animation frame may be a sub-rectangle when the default image is hidden', async () => {
    const result = await convertImage(buildApngFile(hiddenWithSmallFirstFrame()), 'png', { page: 1 }, 'hidden.png', 'png');
    const image = decodeRgba(result.buffer, 'png');
    expect([image.width, image.height]).toEqual([CANVAS, CANVAS]);
    expect(sampleAt(image, 3, 3)).toEqual([...TEAL]);
    expect(sampleAt(image, 0, 0)[3]).toBe(0);
    expect(sampleAt(image, CANVAS - 1, CANVAS - 1)[3]).toBe(0);
    expect(result.frameUsed).toBe(1);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('and the animated output starts with that frame composed on the empty canvas', async () => {
    const result = await convertImage(buildApngFile(hiddenWithSmallFirstFrame()), 'gif', {}, 'hidden.png', 'png');
    expect(countFrames(result.buffer, 'gif')).toBe(2);
    const frames = decodeCoalescedFrames(result.buffer, 'gif');
    expect(sampleAt(frames[0], 3, 3)[3]).toBe(OPAQUE);
    expect(sampleAt(frames[0], 0, 0)[3]).toBe(0);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a visible default image must still cover the canvas', async () => {
    const spec: ApngSpec = { width: CANVAS, height: CANVAS, frames: [{ image: solid(4, 4, TEAL), x: 2, y: 2 }, { image: solid(8, 8, TEAL) }] };
    const error = await captureError(() => convertImage(buildApngFile(spec), 'png', {}, 'visible.png', 'png'));
    expect(error.message).toMatch(/Malformed animated PNG: the default image must cover the whole canvas/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('later frames still have to fit the canvas', async () => {
    const spec = hiddenWithSmallFirstFrame();
    spec.frames[0] = { image: solid(4, 4, TEAL), x: 6, y: 6 };
    const error = await captureError(() => convertImage(buildApngFile(spec), 'png', {}, 'outside.png', 'png'));
    expect(error.message).toMatch(/does not fit the 8x8 canvas/);
  });
});

describe('APNG pixel formats', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK || SKIP_WITHOUT_FFMPEG)('palette frames with a shared PLTE and tRNS', async () => {
    const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const transparency = Buffer.from([255, 128, 255, 0]);
    const indexed = (indices: number[]): PngImage => ({
      width: 4,
      height: 4,
      colourType: COLOUR_TYPE.palette,
      bitDepth: 8,
      pixels: Buffer.from(indices),
    });
    const spec: ApngSpec = {
      width: 4,
      height: 4,
      palette,
      transparency,
      frames: [
        { image: indexed([0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3]) },
        { image: indexed([3, 3, 2, 2, 3, 3, 2, 2, 1, 1, 0, 0, 1, 1, 0, 0]), blend: BLEND_OVER },
      ],
    };
    const apng = buildApngFile(spec);
    const reference = decodeFramesWithFfmpeg(apng, 'apng', 4, 4);
    for (const page of [1, 2]) {
      const result = await convertImage(apng, 'png', { page }, 'anim.png', 'png');
      const actual = decodeRgba(result.buffer, 'png');
      reference.frames[page - 1].forEach((expected, at) => {
        if (at % 4 !== 3 && reference.frames[page - 1][at - (at % 4) + 3] === 0) return;
        expect(Math.abs(actual.data[at] - expected), `page ${page} byte ${at}`).toBeLessThanOrEqual(BLEND_TOLERANCE);
      });
    }
  });

  it.skipIf(SKIP_WITHOUT_MAGICK || SKIP_WITHOUT_FFMPEG)('gray+alpha frames', async () => {
    const grayAlpha = (levels: number[]): PngImage => ({
      width: 2,
      height: 2,
      colourType: COLOUR_TYPE.grayAlpha,
      bitDepth: 8,
      pixels: Buffer.from(levels),
    });
    const spec: ApngSpec = {
      width: 2,
      height: 2,
      frames: [{ image: grayAlpha([10, 255, 90, 255, 170, 255, 250, 255]) }, { image: grayAlpha([200, 128, 200, 128, 0, 0, 40, 255]), blend: BLEND_OVER }],
    };
    const apng = buildApngFile(spec);
    const reference = decodeFramesWithFfmpeg(apng, 'apng', 2, 2);
    const result = await convertImage(apng, 'png', { page: 2 }, 'anim.png', 'png');
    const actual = decodeRgba(result.buffer, 'png');
    for (let pixel = 0; pixel < 4; pixel += 1) {
      const at = pixel * 4;
      expect(Math.abs(actual.data[at] - reference.frames[1][at]), `pixel ${pixel} gray`).toBeLessThanOrEqual(BLEND_TOLERANCE);
      expect(Math.abs(actual.data[at + 3] - reference.frames[1][at + 3]), `pixel ${pixel} alpha`).toBeLessThanOrEqual(BLEND_TOLERANCE);
    }
  });

  // FFmpeg cannot blend 16-bit frames ("Not yet implemented"), so this frame replaces the canvas.
  it.skipIf(SKIP_WITHOUT_MAGICK || SKIP_WITHOUT_FFMPEG)('16-bit RGBA frames are reduced to 8 bits', async () => {
    const rgba16 = (samples: number[]): PngImage => {
      const pixels = Buffer.alloc(samples.length * 2);
      samples.forEach((value, index) => pixels.writeUInt16BE(value, index * 2));
      return { width: 2, height: 1, colourType: COLOUR_TYPE.rgba, bitDepth: 16, pixels };
    };
    const spec: ApngSpec = {
      width: 2,
      height: 1,
      frames: [{ image: rgba16([65535, 0, 0, 65535, 0, 32768, 0, 65535]) }, { image: rgba16([0, 0, 65535, 65535, 65535, 65535, 0, 32768]) }],
    };
    const apng = buildApngFile(spec);
    const reference = decodeFramesWithFfmpeg(apng, 'apng', 2, 1);
    const result = await convertImage(apng, 'png', { page: 2 }, 'anim.png', 'png');
    const actual = decodeRgba(result.buffer, 'png');
    reference.frames[1].forEach((expected, at) => {
      expect(Math.abs(actual.data[at] - expected), `byte ${at}`).toBeLessThanOrEqual(BLEND_TOLERANCE);
    });
  });
});

describe('malformed APNG input fails closed with a typed error', () => {
  const baseSpec = (): ApngSpec => ({
    width: 8,
    height: 8,
    frames: [
      { image: solid(8, 8, [255, 0, 0, 255]) },
      { image: solid(8, 8, [0, 255, 0, 255]) },
      { image: solid(8, 8, [0, 0, 255, 255]) },
    ],
  });
  const ofType = (chunks: Chunk[], type: string, nth = 0): Chunk => chunks.filter((chunk) => chunk.type === type)[nth];
  const fdatSequence = (chunk: Chunk, sequence: number) => chunk.data.writeUInt32BE(sequence, 0);

  const MUTATIONS: ReadonlyArray<readonly [string, (chunks: Chunk[]) => void]> = [
    ['an IHDR with a wrong CRC', (c) => { ofType(c, 'IHDR').crc = 1; }],
    ['an IDAT with a wrong CRC', (c) => { ofType(c, 'IDAT').crc = 1; }],
    ['an fdAT with a wrong CRC', (c) => { ofType(c, 'fdAT', 1).crc = 1; }],
    ['an fcTL with a wrong CRC', (c) => { ofType(c, 'fcTL', 2).crc = 1; }],
    ['an acTL with a wrong CRC', (c) => { ofType(c, 'acTL').crc = 1; }],
    ['an IEND with a wrong CRC', (c) => { ofType(c, 'IEND').crc = 1; }],
    ['a skipped fdAT sequence number', (c) => fdatSequence(ofType(c, 'fdAT', 1), 9)],
    ['a repeated fcTL sequence number', (c) => ofType(c, 'fcTL', 1).data.writeUInt32BE(0, 0)],
    ['a first fcTL that does not start at 0', (c) => ofType(c, 'fcTL', 0).data.writeUInt32BE(1, 0)],
    ['a chunk length beyond the end of the file', (c) => { ofType(c, 'fdAT', 0).declaredLength = 0xffffffff; }],
    ['a chunk length just past the end of the file', (c) => { ofType(c, 'fdAT', 1).declaredLength = ofType(c, 'fdAT', 1).data.length + 1000; }],
    ['a truncated IHDR', (c) => { ofType(c, 'IHDR').data = ofType(c, 'IHDR').data.subarray(0, 5); }],
    ['a truncated fcTL', (c) => { ofType(c, 'fcTL', 1).data = ofType(c, 'fcTL', 1).data.subarray(0, 10); }],
    ['a truncated acTL', (c) => { ofType(c, 'acTL').data = ofType(c, 'acTL').data.subarray(0, 3); }],
    ['a frame region outside the canvas', (c) => ofType(c, 'fcTL', 1).data.writeUInt32BE(5, 12)],
    ['a zero-width frame', (c) => ofType(c, 'fcTL', 1).data.writeUInt32BE(0, 4)],
    ['a default image frame that is smaller than the canvas', (c) => ofType(c, 'fcTL', 0).data.writeUInt32BE(4, 4)],
    ['an unknown dispose operation', (c) => { ofType(c, 'fcTL', 1).data[24] = 3; }],
    ['an unknown blend operation', (c) => { ofType(c, 'fcTL', 1).data[25] = 2; }],
    ['an acTL that announces more frames than the file holds', (c) => ofType(c, 'acTL').data.writeUInt32BE(5, 0)],
    ['an acTL that announces 2^32-1 frames', (c) => ofType(c, 'acTL').data.writeUInt32BE(0xffffffff, 0)],
    ['a missing IEND', (c) => c.splice(c.length - 1, 1)],
    ['a frame without image data', (c) => c.splice(c.indexOf(ofType(c, 'fdAT', 1)), 1)],
  ];

  // An IHDR too short to hold the canvas size fails the input-limit header check before the APNG parser runs.
  const HEADER_UNREADABLE = /^Invalid image: the header could not be decoded \(/;
  it.skipIf(SKIP_WITHOUT_MAGICK).each(MUTATIONS)('rejects %s', async (label, mutate) => {
    const apng = buildApngFile(baseSpec(), mutate);
    const expected = label === 'a truncated IHDR' ? HEADER_UNREADABLE : MALFORMED;
    for (const [target, options] of [['gif', {}], ['png', { page: 2 }], ['png', {}]] as const) {
      const error = await captureError(() => convertImage(apng, target, { ...options }, 'anim.png', 'png'));
      expect(error.name, `${target} ${JSON.stringify(options)}`).toBe('ConversionFailedError');
      expect(error.message).toMatch(expected);
    }
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('rejects a file cut off in the middle of an fdAT chunk', async () => {
    const full = buildApngFile(baseSpec());
    const error = await captureError(() => convertImage(full.subarray(0, full.length - 40), 'gif', {}, 'anim.png', 'png'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(MALFORMED);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a plain PNG is untouched by the APNG checks', async () => {
    const png = encodePng(solid(6, 6, [1, 2, 3, 255]));
    const result = await convertImage(png, 'png', {}, 'plain.png', 'png');
    expect(result.sourceFrameCount).toBeUndefined();
    expect(sampleAt(decodeRgba(result.buffer, 'png'), 3, 3)).toEqual([1, 2, 3, 255]);
  });
});

describe('APNG budgets', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('refuses an animation whose canvas times frames exceeds the decoded animation budget', async () => {
    // Under the 100 Mpx input limit per frame (81 Mpx), over the 512 MiB decoded budget for two RGBA frames.
    const CANVAS = 9000;
    const tiny = solid(1, 1, [9, 9, 9, 255]);
    const spec: ApngSpec = {
      width: CANVAS,
      height: CANVAS,
      hiddenDefault: undefined,
      frames: [{ image: solid(1, 1, [1, 1, 1, 255]) }, { image: tiny, blend: BLEND_OVER }],
    };
    // The first frame must cover the canvas, so build the chunk list with a forged IHDR/fcTL instead.
    const apng = buildApngFile(spec, (chunks) => {
      chunks.find((chunk) => chunk.type === 'fcTL')!.data.writeUInt32BE(CANVAS, 4);
      chunks.find((chunk) => chunk.type === 'fcTL')!.data.writeUInt32BE(CANVAS, 8);
    });
    const error = await captureError(() => convertImage(apng, 'gif', {}, 'big.png', 'png'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/decoded animation limit/);
  });
});

describe('APNG frame count while parsing', () => {
  const FRAME_LIMIT = 4096;
  const ANNOUNCED_FRAMES = 2;
  const oneByOne = (index: number) => ({ image: solid(1, 1, [index % 256, 0, 0, 255]) });
  const framesOf = (count: number) => Array.from({ length: count }, (_unused, index) => oneByOne(index));

  it('stops at the frame control chunk that exceeds the limit, whatever the acTL announces', async () => {
    const apng = buildApngFile({ width: 1, height: 1, frames: framesOf(FRAME_LIMIT + 1) }, (chunks) => {
      chunks.find((chunk) => chunk.type === 'acTL')!.data.writeUInt32BE(ANNOUNCED_FRAMES, 0);
    });
    const error = await captureError(async () => parseApng(apng));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toBe(`The animated PNG has ${FRAME_LIMIT + 1} frames, over the limit of ${FRAME_LIMIT} frames`);
  });

  it('parses an animation with exactly the limit of frames', () => {
    const animation = parseApng(buildApngFile({ width: 1, height: 1, frames: framesOf(FRAME_LIMIT) }));
    expect(animation?.frameCount).toBe(FRAME_LIMIT);
    expect(animation?.frames).toHaveLength(FRAME_LIMIT);
  });
});
