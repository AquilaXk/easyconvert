import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeImageToPng } from '../bench/measure';
import { skipUnless } from './helpers/strict-skip';
import { defaultResolver } from '../bench/tools';

/**
 * The benchmark scores a JPEG by its decoded pixels. ffmpeg's SIMD inverse transforms differ between CPU architectures
 * (the runner's x86-64 build and an arm64 machine decode the same bytes to different pixels, 1 to 2 dB of PSNR on a
 * screenshot), so a baseline measured on one machine failed on the other while the product's bytes were identical. The
 * decode therefore runs ffmpeg's portable C code only, which gives the same pixels everywhere.
 *
 * Oracles: the digest of the decoded samples pinned from the portable path (the same on arm64 and x86-64), and the image
 * library's own libjpeg decode of the same bytes, which must agree to within the rounding of two inverse transforms.
 */

const ffmpeg = defaultResolver()('ffmpeg');
const JPEG = path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg');
const PORTABLE_DECODE_SHA256 = '39a04fb6b4a15f2f96f8f4edae85a288116af74dbc0c4d92c8ca180481053fea';
const MAX_MEAN_ABSOLUTE_DIFFERENCE = 1.5;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-decode-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(skipUnless('ffmpeg', ffmpeg !== null))('JPEG decode of the image benchmark', () => {
  it('gives the same pixels on every CPU architecture, and the pixels the image library decodes', async () => {
    const decoded = path.join(scratch, 'photo-a.png');
    decodeImageToPng('jpg', JPEG, decoded, { ffmpeg: ffmpeg as string, dwebp: null, avifdec: null });
    const ours = await sharp(decoded).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(createHash('sha256').update(ours.data).digest('hex')).toBe(PORTABLE_DECODE_SHA256);

    const library = await sharp(JPEG).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(ours.info.width).toBe(library.info.width);
    expect(ours.info.height).toBe(library.info.height);
    let total = 0;
    for (let i = 0; i < ours.data.length; i++) total += Math.abs(ours.data[i] - library.data[i]);
    expect(total / ours.data.length).toBeLessThan(MAX_MEAN_ABSOLUTE_DIFFERENCE);
  });
});
