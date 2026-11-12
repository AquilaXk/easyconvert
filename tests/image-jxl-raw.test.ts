import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeWithDjxl, findDjxl } from '../src/lib/conversions/image-jxl-cli';
import { rawDecodableMetadata, type RawDecodable } from '../src/lib/conversions/image-jxl-metadata';
import { learnFromDecoderPng, pngFromNetpbm } from '../src/lib/conversions/image-jxl-raw';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildPnm } from './helpers/image-format-builders';
import { decodeRgba, sixteenBitSamples } from './helpers/image-pixels';
import { jxlContainer } from './helpers/jxl-builders';
import { skipUnless } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

runWithoutFileConfinement();

/**
 * `djxl` is asked for the samples of a plain picture as a Netpbm file when the PNG it writes for the same metadata is known (see
 * image-jxl-raw.ts). The PNG that comes back must be the one `djxl` writes itself: the same colour chunks and the same samples.
 */

const needsLibjxl = skipUnless('the libjxl tools (cjxl, djxl)', findDjxl() !== null && getOracleToolPath('cjxl') !== null && getOracleToolPath('djxl') !== null);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxl-raw-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

const PNG_SIGNATURE_BYTES = 8;
const WIDTH = 150;
const HEIGHT = 90;
let fileCount = 0;

const rgb = (maxValue: number, mix: number): number[] => Array.from({ length: WIDTH * HEIGHT * 3 }, (_, i) => (i * mix + (i >> 7)) % (maxValue + 1));

/** A PAM file with the tuple type RGB_ALPHA. */
function buildPam(samples: readonly number[]): Buffer {
  const header = `P7\nWIDTH ${WIDTH}\nHEIGHT ${HEIGHT}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(samples)]);
}

function encode(netpbm: Buffer, extension: string, ...args: string[]): Buffer {
  const id = fileCount++;
  const input = path.join(workDir, `in-${id}.${extension}`);
  const output = path.join(workDir, `out-${id}.jxl`);
  fs.writeFileSync(input, netpbm);
  execFileSync(getOracleToolPath('cjxl') as string, [input, output, '-d', '0', '--quiet', ...args], { stdio: 'pipe' });
  return fs.readFileSync(output);
}

/** The PNG `djxl` itself writes for a file. */
function referencePng(jxl: Buffer): Buffer {
  const id = fileCount++;
  const input = path.join(workDir, `ref-${id}.jxl`);
  const output = path.join(workDir, `ref-${id}.png`);
  fs.writeFileSync(input, jxl);
  execFileSync(getOracleToolPath('djxl') as string, [input, output, '--quiet'], { stdio: 'pipe' });
  return fs.readFileSync(output);
}

interface Chunk {
  type: string;
  bytes: Buffer;
}

function chunksOf(png: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  for (let at = PNG_SIGNATURE_BYTES; at < png.length; at += 12 + png.readUInt32BE(at)) {
    const end = at + 12 + png.readUInt32BE(at);
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), bytes: png.subarray(at, end) });
  }
  return chunks;
}

/** Every chunk but the pixel data, in order. */
const sideChunks = (png: Buffer): Chunk[] => chunksOf(png).filter((chunk) => chunk.type !== 'IDAT');

/** Whether the pixel data is deflated in stored blocks (the first block's type bits are 00), as the PNG made from the samples has it. */
function isStored(png: Buffer): boolean {
  const data = chunksOf(png).find((chunk) => chunk.type === 'IDAT')?.bytes as Buffer;
  return (data[8 + 2] & 0b110) === 0;
}

async function samplesOf(png: Buffer, deep: boolean): Promise<number[] | Buffer> {
  return deep ? sixteenBitSamples(png, 'rgb16') : (await decodeRgba(png)).data;
}

describe.skipIf(needsLibjxl)('the picture taken from the decoder as samples', () => {
  const plain = [
    { name: 'an 8-bit sRGB picture', file: () => encode(buildPnm('P6', WIDTH, HEIGHT, 255, rgb(255, 7)), 'ppm'), deep: false, alpha: false },
    { name: 'a 16-bit picture', file: () => encode(buildPnm('P6', WIDTH, HEIGHT, 65535, rgb(65535, 977)), 'ppm'), deep: true, alpha: false },
    { name: 'an 8-bit picture with alpha', file: () => encode(buildPam(Array.from({ length: WIDTH * HEIGHT * 4 }, (_, i) => (i * 11 + (i >> 6)) % 256)), 'pam'), deep: false, alpha: true },
    { name: 'a picture in a container', file: () => encode(buildPnm('P6', WIDTH, HEIGHT, 255, rgb(255, 5)), 'ppm', '--container=1'), deep: false, alpha: false },
    { name: 'a Rec. 2100 PQ picture', file: () => encode(buildPnm('P6', WIDTH, HEIGHT, 255, rgb(255, 3)), 'ppm', '-x', 'color_space=RGB_D65_202_Rel_PeQ'), deep: false, alpha: false },
    { name: 'a linear picture', file: () => encode(buildPnm('P6', WIDTH, HEIGHT, 255, rgb(255, 9)), 'ppm', '-x', 'color_space=RGB_D65_SRG_Rel_Lin'), deep: false, alpha: false },
    { name: 'a picture with another peak luminance', file: () => encode(buildPnm('P6', WIDTH, HEIGHT, 255, rgb(255, 13)), 'ppm', '--intensity_target=1000'), deep: false, alpha: false },
  ];

  it.each(plain)('is the picture of the decoder’s own PNG for $name', async ({ file, deep, alpha }) => {
    const jxl = file();
    expect(rawDecodableMetadata(jxl)).toMatchObject({ bitsPerSample: deep ? 16 : 8, alpha });
    const expected = referencePng(jxl);
    const first = await decodeWithDjxl(jxl);
    const second = await decodeWithDjxl(jxl);
    expect(isStored(second)).toBe(true);
    for (const png of [first, second]) {
      expect(sideChunks(png)).toEqual(sideChunks(expected));
      expect(await samplesOf(png, deep)).toEqual(await samplesOf(expected, deep));
    }
  });

  it('keeps the samples and the chunks of a picture that is larger than one stored block', async () => {
    const jxl = encode(buildPnm('P6', 400, 300, 255, Array.from({ length: 400 * 300 * 3 }, (_, i) => (i * 7 + (i >> 9)) % 256)), 'ppm');
    await decodeWithDjxl(jxl);
    const second = await decodeWithDjxl(jxl);
    const expected = referencePng(jxl);
    expect(isStored(second)).toBe(true);
    expect(sideChunks(second)).toEqual(sideChunks(expected));
    expect((await decodeRgba(second)).data).toEqual((await decodeRgba(expected)).data);
  });

  const notDescribed = [
    { name: 'a grey picture', file: () => encode(buildPnm('P5', WIDTH, HEIGHT, 255, Array.from({ length: WIDTH * HEIGHT }, (_, i) => (i * 5) % 256)), 'pgm') },
    { name: 'a 12-bit picture', file: () => encode(buildPnm('P6', WIDTH, HEIGHT, 4095, rgb(4095, 17)), 'ppm', '-x', 'color_space=RGB_D65_SRG_Per_SRG', '--override_bitdepth=12') },
  ];

  it.each(notDescribed)('leaves $name to the PNG of the decoder', async ({ file }) => {
    const jxl = file();
    expect(rawDecodableMetadata(jxl)).toBeNull();
    const expected = referencePng(jxl);
    await decodeWithDjxl(jxl);
    const second = await decodeWithDjxl(jxl);
    expect(isStored(second)).toBe(false);
    expect(sideChunks(second)).toEqual(sideChunks(expected));
  });

  it('leaves a picture whose container holds an Exif box to the PNG of the decoder', async () => {
    const codestream = encode(buildPnm('P6', WIDTH, HEIGHT, 255, rgb(255, 7)), 'ppm');
    const withExif = jxlContainer([
      { type: 'Exif', content: Buffer.concat([Buffer.alloc(4), Buffer.from('MM\0*\0\0\0\b\0\0\0\0\0\0', 'latin1')]) },
      { type: 'jxlc', content: codestream },
    ]);
    expect(rawDecodableMetadata(codestream)).not.toBeNull();
    expect(rawDecodableMetadata(withExif)).toBeNull();
  });
});

/** A PNG with the chunks the decoder writes for a picture without alpha when it has an ICC profile: the header, the profile, the data. */
async function pngWithProfile(width: number, height: number): Promise<Buffer> {
  const png = await sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .withIccProfile('p3')
    .png()
    .toBuffer();
  // The image library also writes the pixel density, which the decoder does not.
  return Buffer.concat([png.subarray(0, PNG_SIGNATURE_BYTES), ...chunksOf(png).filter((chunk) => chunk.type !== 'pHYs').map((chunk) => chunk.bytes)]);
}

function netpbm(width: number, height: number, samples: Buffer, header = `P6\n${width} ${height}\n255\n`): Buffer {
  return Buffer.concat([Buffer.from(header, 'latin1'), samples]);
}

const PLAN: RawDecodable = { metadataBits: '1', bitsPerSample: 8, alpha: false };
const DECODER = '/usr/bin/djxl';

describe('the PNG made from the samples of a Netpbm file', () => {
  it('holds the chunks of the decoder’s PNG and the samples, in a stream that inflates to the scanlines', async () => {
    learnFromDecoderPng(DECODER, PLAN, await pngWithProfile(4, 4));
    const width = 211;
    const height = 157;
    const samples = Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 31 + (i >> 8)) % 256));
    const png = pngFromNetpbm(DECODER, PLAN, netpbm(width, height, samples), width * height) as Buffer;
    expect(png).not.toBeNull();
    expect(chunksOf(png).map((chunk) => chunk.type)).toEqual(['IHDR', 'iCCP', 'IDAT', 'IEND']);
    const scanlines = zlib.inflateSync(chunksOf(png).find((chunk) => chunk.type === 'IDAT')?.bytes.subarray(8, -4) as Buffer);
    expect(scanlines.length).toBe((width * 3 + 1) * height);
    for (let row = 0; row < height; row += 1) {
      expect(scanlines[row * (width * 3 + 1)]).toBe(0);
      expect(scanlines.subarray(row * (width * 3 + 1) + 1, (row + 1) * (width * 3 + 1))).toEqual(samples.subarray(row * width * 3, (row + 1) * width * 3));
    }
    expect((await sharp(png).metadata()).icc).toBeDefined();
  });

  it('is refused for a file that is not the picture the headers described', async () => {
    learnFromDecoderPng(DECODER, PLAN, await pngWithProfile(4, 4));
    const samples = Buffer.alloc(6 * 4 * 3, 7);
    expect(pngFromNetpbm(DECODER, PLAN, netpbm(6, 4, samples), 6 * 4)).not.toBeNull();
    expect(pngFromNetpbm(DECODER, PLAN, netpbm(6, 4, samples), 6 * 5)).toBeNull();
    expect(pngFromNetpbm(DECODER, PLAN, netpbm(6, 4, samples, 'P6\n6 4\n4095\n'), 6 * 4)).toBeNull();
    expect(pngFromNetpbm(DECODER, PLAN, netpbm(6, 4, samples.subarray(1)), 6 * 4)).toBeNull();
    expect(pngFromNetpbm(DECODER, PLAN, netpbm(6, 4, samples, 'P5\n6 4\n255\n'), 6 * 4)).toBeNull();
    expect(pngFromNetpbm(DECODER, { ...PLAN, metadataBits: '0' }, netpbm(6, 4, samples), 6 * 4)).toBeNull();
    expect(pngFromNetpbm(DECODER, { ...PLAN, bitsPerSample: 16 }, netpbm(6, 4, samples), 6 * 4)).toBeNull();
  });

  it('is not made from a PNG that holds a chunk besides the colour chunks, such as an EXIF block', async () => {
    const other: RawDecodable = { metadataBits: '0101', bitsPerSample: 8, alpha: false };
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).withExif({ IFD0: { Copyright: 'x' } }).png().toBuffer();
    learnFromDecoderPng(DECODER, other, png);
    expect(pngFromNetpbm(DECODER, other, netpbm(4, 4, Buffer.alloc(48)), 16)).toBeNull();
  });
});
