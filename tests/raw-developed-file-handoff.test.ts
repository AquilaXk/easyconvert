import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { withoutAbsoluteResolution } from '../src/lib/conversions/image-tiff-directories';
import { openLimitedSharp } from '../src/lib/conversions/image-input-limits';
import { encode16BitTiff } from '../src/lib/conversions/raw-hdr';
import { RAW_DECODE_FLAGS } from '../src/worker/raw-decode-settings';
import { developedRawPicture, readDecodedRawImage, readDecodedTiffLayout } from '../src/worker/raw-decoded-tiff';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The picture a camera RAW file develops to (75 MB of 16-bit samples for 12.5 megapixels) stays in the decoder's file and the encoder opens it
 * there, so the Node process never holds it. What the conversion writes must be what it wrote from the buffer, and the file must go with the
 * job's directory however the conversion ends.
 */

vi.setConfig({ testTimeout: 180_000 });

const WIDTH = 96;
const HEIGHT = 64;
const SIXTEEN_BIT_MAX = 65_535;
const TEMP_PREFIX = 'easyconvert-raw-';
const DNG_HEADER = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-handoff-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

/** A developed picture in the layout the decoder writes (one strip, 16-bit RGB, 72 dpi in inches), with a gradient and a repeatable noise. */
function developedTiff(): Buffer {
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  let state = 12_345;
  for (let at = 0; at < samples.length; at += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    const gradient = ((at / 3) % WIDTH) / WIDTH;
    samples[at] = Math.min(SIXTEEN_BIT_MAX, Math.floor(gradient * 60_000) + ((state >>> 16) % 4000));
  }
  return encode16BitTiff(WIDTH, HEIGHT, samples);
}

function writeDeveloped(name: string): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, developedTiff());
  return file;
}

/** The digest of the bytes; a PDF's trailer `/ID` and its dates are made from the time of writing, so they are left out of the digest of a PDF. */
const sha = (bytes: Buffer): string =>
  createHash('sha256')
    .update(bytes.toString('latin1').replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/g, '/ID []').replace(/\(D:\d{14}Z\)/g, '(D:)'), 'latin1')
    .digest('hex');

describe('the developed picture handed to the encoder as a file', () => {
  it('is a header whose pixels are read from the file, with the resolution unit cleared in the file', () => {
    const file = writeDeveloped('unit.tiff');
    const original = fs.readFileSync(file);
    const layout = readDecodedTiffLayout(file);
    const picture = developedRawPicture(file, layout, 'png');

    expect(picture.length).toBe(layout.dataOffset);
    expect(picture.length).toBeLessThan(original.length);
    expect(fs.readFileSync(file).equals(withoutAbsoluteResolution(original))).toBe(true);
    expect(fs.readFileSync(file).equals(original)).toBe(false);
  });

  it('reads as the same picture through sharp as the whole file does', async () => {
    const file = writeDeveloped('sharp.tiff');
    const layout = readDecodedTiffLayout(file);
    const whole = readDecodedRawImage(file);
    fs.writeFileSync(file, developedTiff());
    const picture = developedRawPicture(file, layout, 'png');

    const fromFile = openLimitedSharp(picture);
    const fromBuffer = openLimitedSharp(whole);
    const [fileMeta, bufferMeta] = await Promise.all([fromFile.metadata(), fromBuffer.metadata()]);
    // The library reports the length of a buffer it was given and has no length for a file.
    expect({ ...fileMeta, size: undefined }).toEqual({ ...bufferMeta, size: undefined });
    expect(fileMeta.width).toBe(WIDTH);
    const [filePixels, bufferPixels] = await Promise.all([fromFile.raw().toBuffer(), fromBuffer.raw().toBuffer()]);
    expect(filePixels.equals(bufferPixels)).toBe(true);
  });

  it('is the whole picture for the targets that read their source bytes themselves', () => {
    for (const target of ['hocr', 'alto']) {
      const file = writeDeveloped(`${target}.tiff`);
      const picture = developedRawPicture(file, readDecodedTiffLayout(file), target);
      expect(picture.length).toBe(fs.statSync(file).size);
    }
  });

  it('writes the bytes the buffer wrote, for every target and for resized and metadata-free requests', async () => {
    const targets = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'bmp', 'pdf', 'ps', 'eps', 'psd', 'jxl', 'heic', 'jp2', 'ico', 'tga', 'exr', 'hdr', 'pnm', 'ppm', 'dds', 'pcx'];
    const variants = [{}, { width: 40 }, { stripMetadata: true }, { quality: 40 }];
    let converted = 0;
    for (const target of targets) {
      for (const options of variants) {
        const file = writeDeveloped(`${target}-${JSON.stringify(options)}.tiff`.replace(/[^\w.-]/g, '_'));
        const layout = readDecodedTiffLayout(file);
        const expected = await convertImage(readDecodedRawImage(file), target, options, 'x.dng', 'tiff').then(
          (result) => sha(result.buffer),
          (error: unknown) => `refused: ${(error as Error).message}`
        );
        fs.writeFileSync(file, developedTiff());
        const picture = developedRawPicture(file, layout, target);
        const actual = await convertImage(picture, target, options, 'x.dng', 'tiff').then(
          (result) => sha(result.buffer),
          (error: unknown) => `refused: ${(error as Error).message}`
        );
        expect(actual, `${target} ${JSON.stringify(options)}`).toBe(expected);
        if (!expected.startsWith('refused')) converted += 1;
      }
    }
    expect(converted).toBeGreaterThan(30);
  });
});

/** A decoder that writes the developed picture, then does what `after` says; the engine runs its real sandbox and checks around it. */
function decoderStub(name: string, after: string): string {
  const script = path.join(directory, name);
  const encoded = developedTiff().toString('base64');
  fs.writeFileSync(
    script,
    `#!/bin/sh\nwhile [ "$1" != "-Z" ]; do shift; done\nprintf '%s' '${encoded}' | base64 -d > "$2"\n${after}\n`
  );
  fs.chmodSync(script, 0o755);
  return script;
}

async function withDecoder<T>(stub: string, run: (leftovers: () => string[]) => Promise<T>): Promise<T> {
  const privateTmp = fs.mkdtempSync(path.join(directory, 'tmp-'));
  const previous = { dcraw: process.env.DCRAW_EMU_PATH, tmp: process.env.TMPDIR };
  process.env.DCRAW_EMU_PATH = stub;
  process.env.TMPDIR = privateTmp;
  try {
    expect(os.tmpdir()).toBe(privateTmp);
    return await run(() => fs.readdirSync(privateTmp).filter((name) => name.startsWith(TEMP_PREFIX)));
  } finally {
    if (previous.dcraw === undefined) delete process.env.DCRAW_EMU_PATH;
    else process.env.DCRAW_EMU_PATH = previous.dcraw;
    if (previous.tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous.tmp;
  }
}

describe('the job directory that holds the developed picture', () => {
  it('is gone after a conversion that succeeds, and the output is the picture the file holds', async () => {
    const stub = decoderStub('stub-ok.sh', 'exit 0');
    await withDecoder(stub, async (leftovers) => {
      const result = await dispatchConversion(DNG_HEADER, 'dng', 'png', {}, 'stub.dng');
      expect(result.engineUsed).toBe('native-raw');
      const written = result.buffer;
      const reference = await convertImage(withoutAbsoluteResolution(developedTiff()), 'png', {}, 'stub.dng', 'tiff');
      expect(sha(written)).toBe(sha(reference.buffer));
      expect(leftovers()).toEqual([]);
    });
  });

  it('is gone after a conversion that fails once the picture is developed', async () => {
    const stub = decoderStub('stub-fail.sh', 'exit 0');
    await withDecoder(stub, async (leftovers) => {
      const error = await dispatchConversion(DNG_HEADER, 'dng', 'png', { width: 90_000, height: 90_000 }, 'stub.dng').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(leftovers()).toEqual([]);
    });
  });

  it('is gone after a conversion that is cancelled', async () => {
    const stub = decoderStub('stub-cancel.sh', 'sleep 30');
    await withDecoder(stub, async (leftovers) => {
      const controller = new AbortController();
      const pending = dispatchConversion(DNG_HEADER, 'dng', 'png', { signal: controller.signal }, 'stub.dng').catch((e: unknown) => e);
      setTimeout(() => controller.abort(), 1500);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(leftovers()).toEqual([]);
    });
  });
});

const noTools = skipWithoutTools('dcraw_emu', 'pdfinfo');

describe('a real camera file developed by the decoder', () => {
  it.skipIf(noTools)('converts to the same bytes from the file as from the buffer', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'pix-google-pixel6pro.dng');
    const decoded = path.join(directory, 'pixel.tiff');
    execFileSync(process.env.DCRAW_EMU_PATH ?? 'dcraw_emu', [...RAW_DECODE_FLAGS, '-Z', decoded, sample.path]);
    const layout = readDecodedTiffLayout(decoded);
    for (const target of ['pdf', 'png', 'jpg']) {
      const expected = sha((await convertImage(readDecodedRawImage(decoded), target, {}, 'pixel.dng', 'tiff')).buffer);
      execFileSync(process.env.DCRAW_EMU_PATH ?? 'dcraw_emu', [...RAW_DECODE_FLAGS, '-Z', decoded, sample.path]);
      const actual = sha((await convertImage(developedRawPicture(decoded, layout, target), target, {}, 'pixel.dng', 'tiff')).buffer);
      expect(actual, target).toBe(expected);
    }
  });
});
