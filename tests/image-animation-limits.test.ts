import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { validateOrProblem } from '../src/lib/api/contracts/validate';
import { buildAnimatedWebpFromStill } from './helpers/webp-builder';
import { buildTiffWithOrientation } from './helpers/exif-orientation';
import { captureError } from './helpers/capture-error';
import { countFrames, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * The decoded animation budget (512 MiB of RGBA for all frames) is checked from header metadata before any
 * pixel is decoded or resized, for oriented animations, plain animations and animated resizes. A tiny file
 * that declares a huge canvas must be refused at once, not decoded.
 *
 * Oracles: the animated WebP files are assembled by the hand-written container builder in
 * tests/helpers/webp-builder.ts; the budget arithmetic is spelled out in the tests.
 */

const BUDGET = /decoded animation limit/;
const ROTATED_QUARTER_TURN = 6;
/** 5 frames of 8000 x 4000 RGBA is 640 MiB, over the 512 MiB budget, yet under libvips' own 268 Mpx limit. */
const HUGE_WIDTH = 8000;
const HUGE_HEIGHT = 4000;
const HUGE_FRAMES = 5;
/** A bound far above what a sane run needs: the refusal must not decode a single frame. */
const REFUSAL_MAX_MS = 5000;

async function flatStill(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 90 } } })
    .webp({ lossless: true, effort: 0 })
    .toBuffer();
}

describe('decoded animation budget', () => {
  it('refuses an oriented animation whose frames exceed the budget without decoding them', async () => {
    const still = await flatStill(HUGE_WIDTH, HUGE_HEIGHT);
    const animation = buildAnimatedWebpFromStill(still, {
      width: HUGE_WIDTH,
      height: HUGE_HEIGHT,
      frames: HUGE_FRAMES,
      exif: buildTiffWithOrientation(ROTATED_QUARTER_TURN),
    });
    expect(animation.length).toBeLessThan(still.length * 2 + 1000);
    for (const target of ['gif', 'webp']) {
      const started = Date.now();
      const error = await captureError(() => convertImage(animation, target, {}, 'huge.webp', 'webp'));
      expect(error.name).toBe('ConversionFailedError');
      expect(error.message).toMatch(BUDGET);
      expect(error.message).toContain(`${HUGE_FRAMES} frames of ${HUGE_WIDTH}x${HUGE_HEIGHT}`);
      expect(Date.now() - started).toBeLessThan(REFUSAL_MAX_MS);
    }
  });

  it('refuses a plain animation over the budget too', async () => {
    const still = await flatStill(HUGE_WIDTH, HUGE_HEIGHT);
    const animation = buildAnimatedWebpFromStill(still, { width: HUGE_WIDTH, height: HUGE_HEIGHT, frames: HUGE_FRAMES });
    const error = await captureError(() => convertImage(animation, 'gif', {}, 'huge.webp', 'webp'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(BUDGET);
  });

  it('still converts the first frame of that huge animation to a still target', async () => {
    const FRAME_SIDE = 64;
    const still = await flatStill(FRAME_SIDE, FRAME_SIDE);
    const animation = buildAnimatedWebpFromStill(still, { width: FRAME_SIDE, height: FRAME_SIDE, frames: HUGE_FRAMES });
    const result = await convertImage(animation, 'png', {}, 'small.webp', 'webp');
    expect(result.sourceFrameCount).toBe(HUGE_FRAMES);
    expect(result.frameUsed).toBe(1);
  });
});

describe('animated resize budget', () => {
  const SMALL_SIDE = 64;
  const SMALL_FRAMES = 6;
  const HUGE_TARGET = 16000;

  async function smallAnimation(orientation?: number): Promise<Buffer> {
    return buildAnimatedWebpFromStill(await flatStill(SMALL_SIDE, SMALL_SIDE), {
      width: SMALL_SIDE,
      height: SMALL_SIDE,
      frames: SMALL_FRAMES,
      exif: orientation === undefined ? undefined : buildTiffWithOrientation(orientation),
    });
  }

  it.each([
    ['oriented', ROTATED_QUARTER_TURN],
    ['plain', undefined],
  ])('refuses a %s animation resized to %i-pixel frames before processing a frame', async (_label, orientation) => {
    const animation = await smallAnimation(orientation);
    const started = Date.now();
    const error = await captureError(() =>
      convertImage(animation, 'gif', { width: HUGE_TARGET, height: HUGE_TARGET, fit: 'fill' }, 'small.webp', 'webp')
    );
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(BUDGET);
    expect(error.message).toContain(`${SMALL_FRAMES} frames of ${HUGE_TARGET}x${HUGE_TARGET}`);
    expect(Date.now() - started).toBeLessThan(REFUSAL_MAX_MS);
  });

  it('bounds a one-sided resize by the aspect ratio it implies', async () => {
    const animation = await smallAnimation();
    const error = await captureError(() => convertImage(animation, 'webp', { width: HUGE_TARGET }, 'small.webp', 'webp'));
    expect(error.message).toMatch(BUDGET);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('accepts a resize that stays inside the budget', async () => {
    const animation = await smallAnimation(ROTATED_QUARTER_TURN);
    const result = await convertImage(animation, 'gif', { width: 32 }, 'small.webp', 'webp');
    expect(countFrames(result.buffer, 'gif')).toBe(SMALL_FRAMES);
  });
});

describe('request schema', () => {
  it.each(['width', 'height'])('caps %s at 65535 pixels', (field) => {
    const accepted = validateOrProblem(ConversionOptionsSchema, { [field]: 65535 });
    expect(accepted.ok).toBe(true);
    const rejected = validateOrProblem(ConversionOptionsSchema, { [field]: 65536 });
    expect(rejected.ok).toBe(false);
    expect(rejected.response?.status).toBe(422);
  });
});
