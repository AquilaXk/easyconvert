import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { libraryWritesColours, quantizeGifFrames, quantizeGifPicture } from '../src/lib/conversions/image-gif-colours';
import { readGifLoopCount } from './helpers/animation-containers';
import { meanDeltaE2000 } from './helpers/ciede2000';
import { decodeCoalescedFrames, decodeRgba, frameDelaysMs, requireMagick, runIdentify, SKIP_WITHOUT_MAGICK, withTempImage } from './helpers/imagemagick';

/**
 * A request for N colours writes at most N colours (entry 368 of docs/policy-decisions.md). The image library's GIF writer takes the count as a bit
 * depth, so it wrote 4 entries for 3 colours, 16 for 8 and 256 for 17 to 255. The oracle is ImageMagick: `identify -format %k` counts the distinct
 * colours of a frame (the transparent colour included), `-coalesce` composes the frames as a viewer shows them, and the colour table sizes are read from the
 * bytes of the file. None of it shares code with the writers.
 */

const RGBA = 4;
const WIDTH = 96;
const HEIGHT = 64;
const FRAMES = 6;
const FRAME_DELAY_MS = 80;
const LOOP = 3;
/** The loop field of a GIF counts the repeats after the first play. */
const LOOP_FIELD = LOOP - 1;
const ALPHA_OPAQUE = 255;
const ALPHA_THRESHOLD = 128;
/** Counts that are not a bit depth of the image library, a count that is, and the limits. */
const COUNTS = [3, 5, 8, 32, 64, 100, 200];
const LIBRARY_COUNTS = [2, 4, 16, 256];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-colour-count-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

/** A smooth picture of thousands of colours: three phase-shifted waves, shifted by `phase` pixels for the frames of an animation. */
function gradient(phase: number, alpha: (x: number, y: number) => number = () => ALPHA_OPAQUE): Buffer {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * RGBA);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * RGBA;
      rgba[at] = Math.round(127.5 + 127.5 * Math.sin((x + phase) / 11));
      rgba[at + 1] = Math.round(127.5 + 127.5 * Math.sin((y * 1.3 + x / 2 + phase) / 9));
      rgba[at + 2] = Math.round(127.5 + 127.5 * Math.cos((x + y - phase) / 14));
      rgba[at + 3] = alpha(x, y);
    }
  }
  return rgba;
}

/** Transparent inside a disc, translucent (alpha 100, below the threshold) on a ring around it and opaque elsewhere. */
function holed(x: number, y: number): number {
  const distance = Math.hypot(x - WIDTH / 2, y - HEIGHT / 2);
  if (distance < 14) return 0;
  return distance < 18 ? 100 : ALPHA_OPAQUE;
}

const png = (rgba: Buffer): Promise<Buffer> => sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: RGBA } }).png().toBuffer();

async function animatedWebp(alpha?: (x: number, y: number) => number, orientation?: number): Promise<Buffer> {
  const stack = Buffer.concat(Array.from({ length: FRAMES }, (_, frame) => gradient(frame * 6, alpha)));
  const image = sharp(stack, { raw: { width: WIDTH, height: HEIGHT * FRAMES, channels: RGBA, pageHeight: HEIGHT } });
  return (orientation === undefined ? image : image.withMetadata({ orientation }))
    .webp({ lossless: true, delay: Array(FRAMES).fill(FRAME_DELAY_MS), loop: LOOP })
    .toBuffer();
}

/** Distinct colours of every frame as it is stored (a transparent index counts as one), and of every frame composed on the canvas. */
function colourCounts(gif: Buffer, coalesced: boolean): number[] {
  return withTempImage(gif, 'gif', (file) => {
    const output = coalesced ? execFileSync(requireMagick(), [file, '-coalesce', '-format', '%k\n', 'info:'], { encoding: 'utf8' }) : runIdentify(['-format', '%k\n', file]);
    return output.trim().split('\n').map(Number);
  });
}

/** The entries of the colour tables (global, then local) read from the file's blocks. */
function tableSizes(gif: Buffer): number[] {
  const sizes: number[] = [];
  const global = gif[10] & 0x80 ? 2 ** ((gif[10] & 7) + 1) : 0;
  if (global > 0) sizes.push(global);
  let at = 13 + global * 3;
  while (at < gif.length && gif[at] !== 0x3b) {
    if (gif[at] === 0x21) {
      at += 2;
      while (gif[at] !== 0) at += gif[at] + 1;
      at += 1;
      continue;
    }
    const local = gif[at + 9] & 0x80 ? 2 ** ((gif[at + 9] & 7) + 1) : 0;
    if (local > 0) sizes.push(local);
    at += 10 + local * 3 + 1;
    while (gif[at] !== 0) at += gif[at] + 1;
    at += 1;
  }
  return sizes;
}

const nextPowerOfTwo = (count: number): number => 2 ** Math.max(1, Math.ceil(Math.log2(count)));

async function toGif(input: Buffer, from: string, colors: number, extra: Record<string, unknown> = {}): Promise<Buffer> {
  return (await convertFile(input, from, 'gif', { colors, ...extra }, `input.${from}`)).buffer;
}

describe.skipIf(SKIP_WITHOUT_MAGICK)('a still GIF of N colours', () => {
  it.each(COUNTS)('holds at most %i colours and a table of the next power of two, dithered and not', async (colors) => {
    const source = await png(gradient(0));
    for (const extra of [{}, { dither: true }, { dither: false }]) {
      const gif = await toGif(source, 'png', colors, extra);
      expect(colourCounts(gif, false), JSON.stringify(extra)).toEqual([expect.any(Number)]);
      expect(Math.max(...colourCounts(gif, false)), JSON.stringify(extra)).toBeLessThanOrEqual(colors);
      expect(Math.max(...tableSizes(gif))).toBeLessThanOrEqual(nextPowerOfTwo(colors));
    }
  });

  it.each(COUNTS)('keeps the transparent pixels at %i colours, the transparent colour being one of them', async (colors) => {
    const source = await png(gradient(0, holed));
    const gif = await toGif(source, 'png', colors);
    expect(Math.max(...colourCounts(gif, false))).toBeLessThanOrEqual(colors);
    expect(Math.max(...tableSizes(gif))).toBeLessThanOrEqual(nextPowerOfTwo(colors));
    // Alpha 0 and 100 are both below the threshold of 128, the ring is not opaque in the source, and the GIF holds one bit of alpha.
    const decoded = decodeRgba(gif, 'gif').data;
    const expected = gradient(0, holed);
    for (let at = 3; at < decoded.length; at += RGBA) {
      expect(decoded[at] >= ALPHA_THRESHOLD, `pixel ${(at - 3) / RGBA}`).toBe(expected[at] >= ALPHA_THRESHOLD);
    }
  });

  it.each(LIBRARY_COUNTS)('still holds at most %i colours where the image library writes the count', async (colors) => {
    const gif = await toGif(await png(gradient(0)), 'png', colors, { dither: true });
    expect(Math.max(...colourCounts(gif, false))).toBeLessThanOrEqual(colors);
    expect(Math.max(...tableSizes(gif))).toBe(colors);
  });

  it('writes a picture of fewer colours than asked as it is', async () => {
    const flat = Buffer.alloc(WIDTH * HEIGHT * RGBA);
    const inks = [[255, 0, 0], [0, 128, 0], [0, 0, 255], [250, 250, 20]];
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
      const ink = inks[(pixel % WIDTH < 48 ? 0 : 1) + (Math.floor(pixel / WIDTH) < 32 ? 0 : 2)];
      flat.set([...ink, ALPHA_OPAQUE], pixel * RGBA);
    }
    const gif = await toGif(await png(flat), 'png', 100);
    const decoded = decodeRgba(gif, 'gif').data;
    expect(Buffer.compare(decoded, flat)).toBe(0);
    expect(colourCounts(gif, false)).toEqual([4]);
  });

  it('writes a picture that is all transparent', async () => {
    const gif = await toGif(await png(gradient(0, () => 0)), 'png', 50);
    expect(Math.max(...colourCounts(gif, false))).toBe(1);
    const decoded = decodeRgba(gif, 'gif').data;
    for (let at = 3; at < decoded.length; at += RGBA) expect(decoded[at]).toBe(0);
  });

  it('is better at 100 colours than at 32, by CIEDE2000 against the source', async () => {
    const source = gradient(0);
    const error = async (colors: number) => meanDeltaE2000(decodeRgba(await toGif(await png(source), 'png', colors), 'gif').data, source);
    expect(await error(100)).toBeLessThan(await error(32));
  });

  it('is written by the Oklab quantizer, within the count, where the program is not installed', async () => {
    vi.stubEnv('QUANTIZR_PIXELS_PATH', path.join(scratch, 'no-such-program'));
    for (const colors of [3, 100]) {
      const gif = await toGif(await png(gradient(0, holed)), 'png', colors);
      expect(Math.max(...colourCounts(gif, false))).toBeLessThanOrEqual(colors);
    }
  });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('an animated GIF of N colours', () => {
  it.each(COUNTS)('holds at most %i colours in every frame, stored and composed, and keeps the delays and the loop count', async (colors) => {
    const gif = await toGif(await animatedWebp(), 'webp', colors);
    // The frames are differenced, so a stored frame may hold the transparent index beyond the colours it shows; the composed frames never exceed the count.
    expect(Math.max(...colourCounts(gif, true))).toBeLessThanOrEqual(colors);
    expect(Math.max(...colourCounts(gif, false))).toBeLessThanOrEqual(colors);
    expect(Math.max(...tableSizes(gif))).toBeLessThanOrEqual(nextPowerOfTwo(colors));
    expect(frameDelaysMs(gif, 'gif')).toEqual(Array(FRAMES).fill(FRAME_DELAY_MS));
    expect(readGifLoopCount(gif)).toBe(LOOP_FIELD);
  });

  it.each(COUNTS)('holds at most %i colours in every frame of an animation with transparency', async (colors) => {
    const gif = await toGif(await animatedWebp(holed), 'webp', colors);
    expect(Math.max(...colourCounts(gif, true))).toBeLessThanOrEqual(colors);
    expect(Math.max(...colourCounts(gif, false))).toBeLessThanOrEqual(colors);
    const frames = decodeCoalescedFrames(gif, 'gif');
    expect(frames).toHaveLength(FRAMES);
    frames.forEach((frame, index) => {
      const expected = gradient(index * 6, holed);
      for (let at = 3; at < frame.data.length; at += RGBA) {
        if ((frame.data[at] >= ALPHA_THRESHOLD) !== (expected[at] >= ALPHA_THRESHOLD)) throw new Error(`frame ${index} pixel ${(at - 3) / RGBA} changed its transparency`);
      }
    });
  });

  it.each([2, 4, 16])('writes a valid animation of %i colours: every transparent index lies inside the table', async (colors) => {
    const gif = await toGif(await animatedWebp(holed), 'webp', colors);
    // The image library put the index of a differenced frame past the end of a table below 8 bits; ImageMagick refuses such a file.
    expect(() => colourCounts(gif, false)).not.toThrow();
    expect(Math.max(...colourCounts(gif, true))).toBeLessThanOrEqual(colors);
  });

  it.each([3, 100])('is written frame by frame, within %i colours, from a frame source that the image library cannot orient', async (colors) => {
    const gif = await toGif(await animatedWebp(undefined, 6), 'webp', colors);
    expect(Math.max(...colourCounts(gif, false))).toBeLessThanOrEqual(colors);
    expect(Math.max(...tableSizes(gif))).toBeLessThanOrEqual(nextPowerOfTwo(colors));
    expect(frameDelaysMs(gif, 'gif')).toEqual(Array(FRAMES).fill(FRAME_DELAY_MS));
    expect(readGifLoopCount(gif)).toBe(LOOP_FIELD);
  });

  it('shows no more than the count over the whole animation: the frames share their colours', async () => {
    const frames = decodeCoalescedFrames(await toGif(await animatedWebp(), 'webp', 100), 'gif');
    const shown = new Set<number>();
    for (const frame of frames) for (let at = 0; at < frame.data.length; at += RGBA) shown.add(frame.data.readUIntBE(at, 3));
    expect(shown.size).toBeLessThanOrEqual(100);
  });

  it('gives each frame a palette of its own, within the count, past the size of one shared palette', async () => {
    const frames = 3;
    const stack = Buffer.concat(Array.from({ length: frames }, (_, frame) => gradient(frame * 6, holed)));
    const request = { colours: 20, dither: true, differenced: true };
    const shared = await quantizeGifFrames(Buffer.from(stack), WIDTH, HEIGHT, frames, request);
    const separate = await quantizeGifFrames(Buffer.from(stack), WIDTH, HEIGHT, frames, request, WIDTH * HEIGHT);
    const colourOf = (raster: Buffer, from: number, to: number) => new Set(Array.from({ length: (to - from) / RGBA }, (_, pixel) => raster.readUInt32LE(from + pixel * RGBA))).size;
    const frameBytes = WIDTH * HEIGHT * RGBA;
    expect(colourOf(shared, 0, frames * frameBytes)).toBeLessThanOrEqual(20);
    for (let frame = 0; frame < frames; frame += 1) expect(colourOf(separate, frame * frameBytes, (frame + 1) * frameBytes)).toBeLessThanOrEqual(20);
    expect(colourOf(separate, 0, frames * frameBytes)).toBeGreaterThan(20);
  });

  it('is written by the Oklab quantizer, within the count, where the program is not installed', async () => {
    vi.stubEnv('QUANTIZR_PIXELS_PATH', path.join(scratch, 'no-such-program'));
    const gif = await toGif(await animatedWebp(holed), 'webp', 50);
    expect(Math.max(...colourCounts(gif, true))).toBeLessThanOrEqual(50);
  });
});

describe('the colour counts the image library writes', () => {
  it('are the bit depths 1, 2, 4 and 8', () => {
    for (let colors = 2; colors <= 256; colors += 1) expect(libraryWritesColours(colors), String(colors)).toBe(LIBRARY_COUNTS.includes(colors));
  });
});

describe('the colours a picture is reduced to', () => {
  it('leave a table entry for the transparent index of an opaque frame that is differenced, and none for a frame with transparency', async () => {
    const opaque = await quantizeGifPicture(gradient(0), WIDTH, HEIGHT, { colours: 8, dither: true, differenced: true });
    expect(opaque.paletteSize).toBeLessThanOrEqual(7);
    expect(opaque.transparentIndex).toBe(-1);
    const holes = await quantizeGifPicture(gradient(0, holed), WIDTH, HEIGHT, { colours: 8, dither: true, differenced: true });
    expect(holes.paletteSize).toBeLessThanOrEqual(8);
    expect(holes.paletteSize).toBeGreaterThan(7);
    expect(holes.transparentIndex).toBeGreaterThanOrEqual(0);
  });
});
