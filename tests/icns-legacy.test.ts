import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { IcnsDecodeError, decodeIcns } from '../src/lib/conversions/ico';
import { findOpenJpeg } from '../src/lib/conversions/image-openjpeg-cli';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildPnm } from './helpers/image-format-builders';
import { decodeRgba, rgbaBytes } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * ICNS files hold more than PNG: Apple's own icon files from before OS X 10.7 hold 24-bit run-length colour elements with
 * 8-bit masks (is32 il32 ih32 it32 with s8mk l8mk h8mk t8mk), ic04 and ic05 hold ARGB, and the elements from 128x128 up may be JPEG
 * 2000. Each was refused with "it holds no PNG or JPEG image to decode" (the sweep of 2026-11-20). The elements here are written by hand
 * from the layout of the format, and the macOS icon files were compared pixel for pixel with the macOS decoder when the reader was written.
 */

function icns(chunks: Array<{ type: string; data: Buffer }>): Buffer {
  const body = Buffer.concat(chunks.map((c) => Buffer.concat([Buffer.from(c.type, 'ascii'), u32(8 + c.data.length), c.data])));
  return Buffer.concat([Buffer.from('icns', 'ascii'), u32(8 + body.length), body]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

/** A channel as the format codes it: a run of the same byte is `count + 125` then the byte, anything else is `count - 1` then the bytes. */
function runLengthChannel(values: readonly number[]): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < values.length) {
    let run = 1;
    while (i + run < values.length && values[i + run] === values[i] && run < 130) run++;
    if (run >= 3) {
      out.push(run + 125, values[i]);
      i += run;
      continue;
    }
    let end = i + 1;
    while (end < values.length && end - i < 128 && !(end + 2 < values.length && values[end] === values[end + 1] && values[end] === values[end + 2])) end++;
    out.push(end - i - 1, ...values.slice(i, end));
    i = end;
  }
  return Buffer.from(out);
}

const SIDE = 16;
const pixels = Array.from({ length: SIDE * SIDE }, (_, i) => ({
  r: i < 100 ? 200 : (i * 5) % 256,
  g: i < 100 ? 30 : (i * 11) % 256,
  b: i < 100 ? 90 : (i * 17) % 256,
  a: i % 7 === 0 ? 0 : 255 - (i % 5) * 20,
}));

function colourElement(): Buffer {
  return Buffer.concat([pixels.map((p) => p.r), pixels.map((p) => p.g), pixels.map((p) => p.b)].map(runLengthChannel));
}

function maskElement(): Buffer {
  return Buffer.from(pixels.map((p) => p.a));
}

function argbElement(): Buffer {
  return Buffer.concat([Buffer.from('ARGB', 'latin1'), ...[pixels.map((p) => p.a), pixels.map((p) => p.r), pixels.map((p) => p.g), pixels.map((p) => p.b)].map(runLengthChannel)]);
}

describe('old-style ICNS pictures', () => {
  it('reads an is32 colour element with its s8mk mask', async () => {
    const file = icns([{ type: 'is32', data: colourElement() }, { type: 's8mk', data: maskElement() }]);
    const decoded = await decodeRgba((await dispatchConversion(file, 'icns', 'png', {}, 'a.icns')).buffer);
    expect([decoded.width, decoded.height]).toEqual([SIDE, SIDE]);
    expect(decoded.data).toEqual(rgbaBytes(pixels));
  });

  it('is opaque when an element has no mask, and reads uncompressed colour', async () => {
    const rgb = Buffer.from(pixels.flatMap((p) => [p.r, p.g, p.b]));
    const decoded = await decodeRgba((await dispatchConversion(icns([{ type: 'is32', data: rgb }]), 'icns', 'png', {}, 'a.icns')).buffer);
    expect(decoded.data).toEqual(rgbaBytes(pixels.map((p) => ({ ...p, a: 255 }))));
  });

  it('reads the ARGB element of ic04 as alpha, red, green, blue', async () => {
    const decoded = await decodeRgba((await dispatchConversion(icns([{ type: 'ic04', data: argbElement() }]), 'icns', 'png', {}, 'a.icns')).buffer);
    expect(decoded.data).toEqual(rgbaBytes(pixels));
  });

  it('prefers the larger element and reads the 128x128 element after its four zero bytes', () => {
    const side = 128;
    const flat = (value: number) => runLengthChannel(Array.from({ length: side * side }, () => value));
    const it32 = Buffer.concat([u32(0), flat(10), flat(20), flat(30)]);
    const picture = decodeIcns(icns([{ type: 'is32', data: colourElement() }, { type: 'it32', data: it32 }, { type: 't8mk', data: Buffer.alloc(side * side, 255) }]));
    expect(picture.kind).toBe('raster');
    if (picture.kind !== 'raster') return;
    expect([picture.width, picture.height]).toEqual([side, side]);
    expect([...picture.rgba.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
  });

  it('never guesses: a short channel, bytes after the last channel, a mask of the wrong size and a bad 128x128 header are refused', () => {
    const good = colourElement();
    const cases: Array<[string, Buffer]> = [
      ['short channel', icns([{ type: 'is32', data: good.subarray(0, good.length - 3) }])],
      ['trailing bytes', icns([{ type: 'is32', data: Buffer.concat([good, Buffer.from([1, 2, 3])]) }])],
      ['mask size', icns([{ type: 'is32', data: good }, { type: 's8mk', data: Buffer.alloc(10) }])],
      ['it32 header', icns([{ type: 'it32', data: Buffer.alloc(100) }])],
      ['ARGB tag', icns([{ type: 'ic04', data: Buffer.concat([Buffer.from('ABGR'), good]) }])],
    ];
    for (const [label, file] of cases) {
      expect(() => decodeIcns(file), label).toThrow(IcnsDecodeError);
    }
  });

  it('names what a picture-less file lacks', () => {
    expect(() => decodeIcns(icns([{ type: 'info', data: Buffer.from('bplist00') }]))).toThrow(/no picture element/);
  });
});

const needsOpenJpeg = skipUnless('the OpenJPEG tools (opj_compress, opj_decompress)', findOpenJpeg() !== null && getOracleToolPath('opj_compress') !== null);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icns-jp2-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe.skipIf(needsOpenJpeg)('JPEG 2000 elements of an ICNS file', () => {
  const WIDTH = 32;
  const gradient = Array.from({ length: WIDTH * WIDTH }, (_, i) => ({ r: (i * 7) % 256, g: (i * 13 + 5) % 256, b: (i * 29 + 11) % 256, a: 255 }));

  it('decodes an ic09 element that holds a JP2 file to the pixels that were encoded', async () => {
    const input = path.join(workDir, 'in.ppm');
    const output = path.join(workDir, 'out.jp2');
    fs.writeFileSync(input, buildPnm('P6', WIDTH, WIDTH, 255, gradient.flatMap((p) => [p.r, p.g, p.b])));
    execFileSync(getOracleToolPath('opj_compress') as string, ['-i', input, '-o', output], { stdio: 'pipe' });
    const file = icns([{ type: 'ic09', data: fs.readFileSync(output) }]);
    const decoded = await decodeRgba((await dispatchConversion(file, 'icns', 'png', {}, 'jp2.icns')).buffer);
    expect([decoded.width, decoded.height]).toEqual([WIDTH, WIDTH]);
    expect(decoded.data).toEqual(rgbaBytes(gradient));
  });

  it('converts the real Apache Tika file whose only element is a 512x512 JPEG 2000 picture', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'tika-testicns_basic.icns');
    const decoded = await decodeRgba((await dispatchConversion(sample.bytes, 'icns', 'png', {}, 'testICNS_basic.icns')).buffer);
    expect([decoded.width, decoded.height]).toEqual([512, 512]);
  });
});
