import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { findOpenJpeg, OPJ_DECOMPRESS_PATH_ENV } from '../src/lib/conversions/image-openjpeg-cli';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildPnm } from './helpers/image-format-builders';
import { decodeRgba, maxSampleDifference, rgbaBytes, sixteenBitSamples } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * JPEG 2000 pictures (JP2 files and bare codestreams, ITU-T T.800) convert through OpenJPEG (#783: every one was refused with
 * "header could not be decoded"). The pictures are written by OpenJPEG's own encoder, losslessly, from pixels the test knows, so
 * the decode is judged against those pixels; the real files of the corpus are judged against the reference decoder.
 */

const needsOpenJpeg = skipUnless('the OpenJPEG tools (opj_compress, opj_decompress)', findOpenJpeg() !== null && getOracleToolPath('opj_compress') !== null);

/** The largest real file is a 10-megapixel picture, decoded twice and compared. */
const REAL_FILE_TIMEOUT_MS = 60_000;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpeg2000-decode-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

/** Encodes a Netpbm file losslessly with the reference encoder; `extra` are further encoder options (an image offset). */
function encodeJpeg2000(netpbm: Buffer, extension: 'jp2' | 'j2k', extra: readonly string[] = []): Buffer {
  const input = path.join(workDir, `in-${extension}-${extra.length}.${netpbm.toString('latin1', 0, 2) === 'P6' ? 'ppm' : 'pgm'}`);
  const output = path.join(workDir, `out-${extension}-${extra.length}.${extension}`);
  fs.writeFileSync(input, netpbm);
  execFileSync(getOracleToolPath('opj_compress') as string, ['-i', input, '-o', output, ...extra], { stdio: 'pipe' });
  return fs.readFileSync(output);
}

const WIDTH = 64;
const HEIGHT = 48;
const gradient = Array.from({ length: WIDTH * HEIGHT }, (_, i) => ({ r: (i * 7) % 256, g: (i * 13 + 5) % 256, b: (i * 29 + 11) % 256, a: 255 }));
const gradientNetpbm = buildPnm('P6', WIDTH, HEIGHT, 255, gradient.flatMap((p) => [p.r, p.g, p.b]));

describe.skipIf(needsOpenJpeg)('JPEG 2000 pictures with known pixels', () => {
  it.each([
    ['JP2 file', 'jp2' as const],
    ['codestream', 'j2k' as const],
  ])('decodes a lossless %s to the pixels that were encoded', async (_label, extension) => {
    const decoded = await decodeRgba((await dispatchConversion(encodeJpeg2000(gradientNetpbm, extension), extension, 'png', {}, `p.${extension}`)).buffer);
    expect([decoded.width, decoded.height]).toEqual([WIDTH, HEIGHT]);
    expect(decoded.data).toEqual(rgbaBytes(gradient));
  });

  it('takes the size of a picture from the reference grid less its offset (T.800 B.2)', async () => {
    const offset = encodeJpeg2000(gradientNetpbm, 'j2k', ['-d', '10,20']);
    const decoded = await decodeRgba((await dispatchConversion(offset, 'j2k', 'png', {}, 'offset.j2k')).buffer);
    expect([decoded.width, decoded.height]).toEqual([WIDTH, HEIGHT]);
    expect(decoded.data).toEqual(rgbaBytes(gradient));
  });

  it('keeps the 16 bits of a deep grey picture', async () => {
    const samples = [0, 257, 40000, 65535, 1, 65534];
    const jp2 = encodeJpeg2000(buildPnm('P5', 64, 48, 65535, Array.from({ length: 64 * 48 }, (_, i) => samples[i % samples.length])), 'jp2');
    const decoded = await sixteenBitSamples((await dispatchConversion(jp2, 'jp2', 'png', {}, 'deep.jp2')).buffer, 'grey16');
    expect(decoded).toEqual(Array.from({ length: 64 * 48 }, (_, i) => samples[i % samples.length]));
  });

  it('finds the codestream behind boxes of every length form (T.800 I.4: a 32-bit length, a 64-bit length, a length to the end)', async () => {
    const jp2 = encodeJpeg2000(gradientNetpbm, 'jp2');
    // The codestream box is the last box of the file OpenJPEG writes: its 32-bit length, its type, then the codestream.
    const codestreamBox = jp2.indexOf('jp2c', 0, 'latin1') - 4;
    const box = (type: string, content: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(8 + content.length, 0);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, content]);
    };
    const largeBox = (type: string, content: Buffer): Buffer => {
      const head = Buffer.alloc(16);
      head.writeUInt32BE(1, 0);
      head.write(type, 4, 'latin1');
      head.writeBigUInt64BE(BigInt(16 + content.length), 8);
      return Buffer.concat([head, content]);
    };
    const toEnd = Buffer.from(jp2);
    toEnd.writeUInt32BE(0, codestreamBox);
    for (const file of [
      Buffer.concat([jp2.subarray(0, codestreamBox), box('free', Buffer.alloc(5)), jp2.subarray(codestreamBox)]),
      Buffer.concat([jp2.subarray(0, codestreamBox), largeBox('xml ', Buffer.alloc(3)), jp2.subarray(codestreamBox)]),
      toEnd,
    ]) {
      const decoded = await decodeRgba((await dispatchConversion(file, 'jp2', 'png', {}, 'boxes.jp2')).buffer);
      expect(decoded.data).toEqual(rgbaBytes(gradient));
    }
  });

  it('takes the kind of file from its bytes, not from the name it was uploaded under', async () => {
    const codestream = encodeJpeg2000(gradientNetpbm, 'j2k');
    const decoded = await decodeRgba((await dispatchConversion(codestream, 'jp2', 'png', {}, 'misnamed.jp2')).buffer);
    expect(decoded.data).toEqual(rgbaBytes(gradient));
  });
});

describe.skipIf(needsOpenJpeg)('real JPEG 2000 files', () => {
  it.for([
    ['vips-world.jp2', 'jp2', 800, 400],
    ['tika-testjpeg.jp2', 'jp2', 100, 75],
    // The codestream starts at (150, 300) of a 2742 x 2244 grid: the picture is 2592 x 1944 pixels.
    ['vips-bretagne2_4.j2k', 'j2k', 2592, 1944],
    ['pil-16bit.cropped.j2k', 'j2k', 64, 64],
  ] as const)('decodes %s to the picture the reference decoder writes', { timeout: REAL_FILE_TIMEOUT_MS }, async ([id, format, width, height], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const converted = await decodeRgba((await dispatchConversion(sample.bytes, format, 'png', {}, id)).buffer);
    expect([converted.width, converted.height]).toEqual([width, height]);
    const reference = path.join(workDir, `${id}.png`);
    execFileSync(getOracleToolPath('opj_decompress') as string, ['-i', sample.path, '-o', reference], { stdio: 'pipe' });
    expect(maxSampleDifference(converted, await decodeRgba(fs.readFileSync(reference)))).toBe(0);
  });
});

describe.skipIf(needsOpenJpeg)('JPEG 2000 files that cannot be decoded', () => {
  it('refuses bytes that are neither a JP2 file nor a codestream', async () => {
    await expect(dispatchConversion(Buffer.from('not a picture, just text'), 'jp2', 'png', {}, 'x.jp2')).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the JPEG 2000 header could not be decoded' });
  });

  it('refuses a JP2 file whose boxes do not lead to a codestream, and a codestream header that is cut or empty', async () => {
    const header = 'Invalid image: the JPEG 2000 header could not be decoded';
    const signature = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
    const box = (length: number, type: string, content: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(length, 0);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, content]);
    };
    const codestream = encodeJpeg2000(gradientNetpbm, 'j2k');
    await expect(dispatchConversion(signature, 'jp2', 'png', {}, 'a.jp2')).rejects.toMatchObject({ message: header });
    await expect(dispatchConversion(Buffer.concat([signature, box(0, 'free', Buffer.alloc(4))]), 'jp2', 'png', {}, 'b.jp2')).rejects.toMatchObject({ message: header });
    await expect(dispatchConversion(Buffer.concat([signature, box(4, 'free', Buffer.alloc(4))]), 'jp2', 'png', {}, 'c.jp2')).rejects.toMatchObject({ message: header });
    const cutLarge = Buffer.concat([signature, box(1, 'free', Buffer.alloc(4))]);
    await expect(dispatchConversion(cutLarge, 'jp2', 'png', {}, 'd.jp2')).rejects.toMatchObject({ message: header });
    await expect(dispatchConversion(Buffer.concat([signature, box(8, 'jp2c', Buffer.from('ff4fff51', 'hex'))]), 'jp2', 'png', {}, 'e.jp2')).rejects.toMatchObject({ message: header });
    await expect(dispatchConversion(Buffer.concat([signature, box(24, 'jp2c', Buffer.alloc(16))]), 'jp2', 'png', {}, 'f.jp2')).rejects.toMatchObject({ message: header });
    await expect(dispatchConversion(codestream.subarray(0, 20), 'j2k', 'png', {}, 'g.j2k')).rejects.toMatchObject({ message: header });
  });

  it('refuses a codestream whose grid offset leaves no picture', async () => {
    const whole = Buffer.from(encodeJpeg2000(gradientNetpbm, 'j2k'));
    // SIZ: Xsiz, Ysiz, XOsiz and YOsiz follow the marker (4), Lsiz (2) and Rsiz (2); an offset equal to the grid size is an empty picture.
    whole.writeUInt32BE(whole.readUInt32BE(8), 16);
    await expect(dispatchConversion(whole, 'j2k', 'png', {}, 'empty.j2k')).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the JPEG 2000 header declares no picture' });
  });

  it('refuses a codestream that ends before its pixels do', async () => {
    const whole = encodeJpeg2000(gradientNetpbm, 'j2k');
    await expect(dispatchConversion(whole.subarray(0, whole.length - 40), 'j2k', 'png', {}, 'cut.j2k')).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the JPEG 2000 picture could not be decoded' });
  });

  it('refuses a tiny codestream that declares a picture over the input limit before decoding it', async () => {
    const whole = Buffer.from(encodeJpeg2000(gradientNetpbm, 'j2k'));
    // SIZ segment: marker (4 bytes: SOC, SIZ), Lsiz, Rsiz, then Xsiz and Ysiz.
    whole.writeUInt32BE(30_000, 8);
    whole.writeUInt32BE(30_000, 12);
    await expect(dispatchConversion(whole, 'j2k', 'png', {}, 'huge.j2k')).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413, width: 30_000, height: 30_000 });
  });

  it('names the missing engine when OpenJPEG is not installed', async () => {
    const saved = process.env[OPJ_DECOMPRESS_PATH_ENV];
    process.env[OPJ_DECOMPRESS_PATH_ENV] = '/nonexistent/opj_decompress';
    try {
      await expect(dispatchConversion(encodeJpeg2000(gradientNetpbm, 'jp2'), 'jp2', 'png', {}, 'x.jp2')).rejects.toMatchObject({ name: 'EngineUnavailableError', engineName: 'opj_decompress' });
    } finally {
      if (saved === undefined) delete process.env[OPJ_DECOMPRESS_PATH_ENV];
      else process.env[OPJ_DECOMPRESS_PATH_ENV] = saved;
    }
  });
});
