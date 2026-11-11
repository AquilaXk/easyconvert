import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { CJPEGLI_PATH_ENV, type JpegliEncoderFaultError } from '../src/lib/conversions/jpegli-cli';
import { requireOracleTool } from './helpers/differential-oracle';
import { injectExifOrientation, readExifOrientation } from './helpers/exif-orientation';
import { interface16 } from './helpers/graphic-parity';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * JPEG of a photograph through the jpegli program (src/lib/conversions/jpegli-cli.ts). The oracles are sharp's reader for the shape of the
 * file (size, components, metadata) and the library encoder's own file of the same conversion: the program is the only thing that differs
 * between a run with it and a run without it, so every metadata block, the orientation and the pixel size must agree between the two, and
 * the scan, the quality and the content rule are what the program changes.
 */

const WIDTH = 192;
const HEIGHT = 128;
const SOF_BASELINE = 0xc0;
const SOF_PROGRESSIVE = 0xc2;
const SCRIPT_MODE = 0o755;
const MARKER_PREFIX = 0xff;
const MARKER_SOS = 0xda;
const SAMPLING_NIBBLE = 16;
const toolsMissing = skipWithoutTools('cjpegli-pinned');
/** Found before any test points the variable at another file. */
const PROGRAM = toolsMissing ? '' : requireOracleTool('cjpegli-pinned');

let workDir: string;
const savedPath = process.env[CJPEGLI_PATH_ENV];

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'jpegli-pipeline-'));
});
afterEach(() => {
  if (savedPath === undefined) delete process.env[CJPEGLI_PATH_ENV];
  else process.env[CJPEGLI_PATH_ENV] = savedPath;
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A continuous-tone picture: smooth colour fields with deterministic grain, so that the classifier calls it a photograph. */
async function photoPng(options: { profile?: boolean; grey?: boolean } = {}): Promise<Buffer> {
  const channels = options.grey ? 1 : 3;
  const data = Buffer.alloc(WIDTH * HEIGHT * channels);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const grain = ((Math.imul(x * 73856093, 1) ^ Math.imul(y * 19349663, 1)) >>> 0) % 21;
      for (let c = 0; c < channels; c += 1) {
        const field = 128 + 90 * Math.sin((x + 40 * c) / 23) * Math.cos((y - 17 * c) / 19);
        data[(y * WIDTH + x) * channels + c] = Math.max(0, Math.min(255, Math.round(field + grain - 10)));
      }
    }
  }
  const image = sharp(data, { raw: { width: WIDTH, height: HEIGHT, channels } });
  const tagged = options.profile ? image.withIccProfile('p3') : image;
  return (options.grey ? tagged.toColourspace('b-w') : tagged).png().toBuffer();
}

/** The start-of-frame segment of a JPEG: its marker and the sampling factors of its components. */
function frameOf(jpeg: Buffer): { marker: number; samplingOfFirst: number; components: number } {
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === MARKER_PREFIX) {
    const marker = jpeg[at + 1];
    if (marker === MARKER_SOS) break;
    if (marker >= 0xc0 && marker <= 0xc2) return { marker, components: jpeg[at + 9], samplingOfFirst: jpeg[at + 11] };
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  throw new Error('no frame header');
}

/** Converts with the program the oracle finds, or with none installed. */
async function convert(source: Buffer, options: Parameters<typeof convertImage>[2], withProgram: boolean, name = 'photo.png', format = 'png'): Promise<Buffer> {
  if (withProgram) process.env[CJPEGLI_PATH_ENV] = PROGRAM;
  else process.env[CJPEGLI_PATH_ENV] = path.join(workDir, 'no-such-program');
  return (await convertImage(source, 'jpg', options, name, format)).buffer;
}

describe.skipIf(toolsMissing)('a photograph written through the jpegli program', () => {
  it('is a progressive JPEG of the picture\'s size that the library reads, with 4:2:0 chroma below quality 90 and 4:4:4 from it', async () => {
    const source = await photoPng();
    const low = await convert(source, { quality: 70 }, true);
    const high = await convert(source, { quality: 92 }, true);
    expect(await sharp(low).metadata()).toMatchObject({ format: 'jpeg', width: WIDTH, height: HEIGHT, channels: 3, isProgressive: true });
    expect(frameOf(low)).toMatchObject({ marker: SOF_PROGRESSIVE, components: 3, samplingOfFirst: 2 * SAMPLING_NIBBLE + 2 });
    expect(frameOf(high)).toMatchObject({ marker: SOF_PROGRESSIVE, components: 3, samplingOfFirst: 1 * SAMPLING_NIBBLE + 1 });
  });

  it('is a different file from the library encoder\'s, which stays baseline, and the quality setting moves the size and the error', async () => {
    const source = await photoPng();
    const library = await convert(source, { quality: 70 }, false);
    const program = await convert(source, { quality: 70 }, true);
    expect(frameOf(library).marker).toBe(SOF_BASELINE);
    expect(program.equals(library)).toBe(false);
    const sizes = [] as number[];
    const errors = [] as number[];
    const reference = await sharp(source).raw().toBuffer();
    for (const quality of [30, 60, 90]) {
      const jpeg = await convert(source, { quality }, true);
      sizes.push(jpeg.length);
      const decoded = await sharp(jpeg).raw().toBuffer();
      errors.push(decoded.reduce((sum, value, index) => sum + Math.abs(value - reference[index]), 0) / decoded.length);
    }
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
    expect(errors[0]).toBeGreaterThan(errors[1]);
    expect(errors[1]).toBeGreaterThan(errors[2]);
  });

  it('keeps a grey picture to one component, with no chroma subsampling asked for', async () => {
    const source = await photoPng({ grey: true });
    const jpeg = await convert(source, { quality: 70 }, true);
    expect(frameOf(jpeg)).toMatchObject({ marker: SOF_PROGRESSIVE, components: 1 });
    expect(await sharp(jpeg).metadata()).toMatchObject({ channels: 1, width: WIDTH, height: HEIGHT });
  });

  it('applies a resize before the encoder sees the picture', async () => {
    const jpeg = await convert(await photoPng(), { quality: 70, width: 96 }, true);
    expect(await sharp(jpeg).metadata()).toMatchObject({ width: 96, height: 64 });
  });

  it('writes the metadata the library encoder writes: the profile, the orientation turned in, no block that the library leaves out', async () => {
    const source = await photoPng({ profile: true });
    const withProgram = await sharp(await convert(source, { quality: 70 }, true)).metadata();
    const without = await sharp(await convert(source, { quality: 70 }, false)).metadata();
    expect(withProgram.icc?.length).toBeGreaterThan(0);
    expect(withProgram.icc?.equals(without.icc ?? Buffer.alloc(0))).toBe(true);
    expect(withProgram.exif).toEqual(without.exif);
    expect(withProgram.density).toBe(without.density);
    expect(withProgram.width).toBe(without.width);
  });

  it('turns a picture by its EXIF orientation and writes the orientation the library writes', async () => {
    const jpegSource = await sharp(await photoPng()).jpeg({ quality: 95 }).toBuffer();
    const rotated = injectExifOrientation(jpegSource, 6);
    const withProgram = await convert(rotated, { quality: 70 }, true, 'rotated.jpg', 'jpg');
    const without = await convert(rotated, { quality: 70 }, false, 'rotated.jpg', 'jpg');
    expect(await sharp(withProgram).metadata()).toMatchObject({ width: HEIGHT, height: WIDTH });
    expect(readExifOrientation(withProgram)).toBe(readExifOrientation(without));
  });

  it('drops the metadata when the request strips it, as the library encoder does', async () => {
    const source = await photoPng({ profile: true });
    const stripped = await sharp(await convert(source, { quality: 70, stripMetadata: true }, true)).metadata();
    const library = await sharp(await convert(source, { quality: 70, stripMetadata: true }, false)).metadata();
    expect(stripped.icc).toEqual(library.icc);
    expect(stripped.exif).toEqual(library.exif);
  });

  it('leaves a graphic to the library encoder, so that its file is the file of a worker without the program', async () => {
    const source = await interface16();
    const withProgram = await convert(source, { quality: 70 }, true, 'ui.png');
    const without = await convert(source, { quality: 70 }, false, 'ui.png');
    expect(withProgram.equals(without)).toBe(true);
    expect(frameOf(withProgram).marker).toBe(SOF_BASELINE);
  });

  it('is the library encoder\'s answer when no program is installed, with no error', async () => {
    const jpeg = await convert(await photoPng(), { quality: 70 }, false);
    expect(frameOf(jpeg).marker).toBe(SOF_BASELINE);
  });

  it('is an error, not the library\'s file, when the installed program fails', async () => {
    const failing = path.join(workDir, 'fails-after-help');
    writeFileSync(failing, '#!/bin/sh\ncase "$1" in -v) printf \'%s\\n\' "Usage: cjpegli INPUT OUTPUT --quality --chroma_subsampling --progressive_level --quiet"; exit 0;; esac\ncat > /dev/null\necho boom >&2\nexit 3\n');
    chmodSync(failing, SCRIPT_MODE);
    process.env[CJPEGLI_PATH_ENV] = failing;
    const error = (await convertImage(await photoPng(), 'jpg', { quality: 70 }, 'photo.png', 'png').catch((e: unknown) => e)) as JpegliEncoderFaultError;
    expect(error).toMatchObject({ name: 'JpegliEncoderFaultError', message: 'Cannot encode the image as .jpg (the JPEG encoder failed on the picture)' });
  });
});
