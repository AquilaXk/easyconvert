import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { AVIF_MAX_BOXES, readAvifColour, setAvifColour } from '../src/lib/conversions/avif-colour';
import {
  CICP_MATRIX_IDENTITY,
  CICP_PRIMARIES_BT2020,
  CICP_PRIMARIES_BT709,
  CICP_TRANSFER_PQ,
  CICP_TRANSFER_SRGB,
  ColourTagError,
  readPngCicp,
  writePngCicp,
} from '../src/lib/conversions/cicp';
import { ConversionFailedError } from '../src/lib/types';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Colour tags are read back with ffprobe, exiftool, pngcheck and avifdec, none of which share code with the writer.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'colour-tags-'));
let counter = 0;
function write(name: string, data: Buffer): string {
  counter += 1;
  const file = path.join(dir, `${counter}-${name}`);
  writeFileSync(file, data);
  return file;
}

function probe(file: string): Record<string, string> {
  const text = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range,pix_fmt', '-of', 'default=nw=1', file], { encoding: 'utf8' });
  return Object.fromEntries(text.trim().split('\n').map((line) => line.split('=')));
}

async function solid(width = 48, height = 40): Promise<ReturnType<typeof sharp>> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      raw[(y * width + x) * 3] = (x * 5) & 255;
      raw[(y * width + x) * 3 + 1] = (y * 6) & 255;
      raw[(y * width + x) * 3 + 2] = ((x + y) * 3) & 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

describe.skipIf(skipWithoutTools('ffprobe', 'avifdec'))('AVIF colour description', () => {
  let plain: Buffer;

  beforeAll(async () => {
    plain = await (await solid()).avif({ bitdepth: 10, chromaSubsampling: '4:4:4' }).toBuffer();
  });

  it('reads what the encoder wrote, in agreement with ffprobe', () => {
    const cicp = readAvifColour(plain);
    const oracle = probe(write('plain.avif', plain));
    expect(cicp).toEqual({ primaries: CICP_PRIMARIES_BT709, transfer: CICP_TRANSFER_SRGB, matrix: 6, fullRange: true });
    expect(oracle).toMatchObject({ color_primaries: 'bt709', color_transfer: 'iec61966-2-1', color_space: 'smpte170m' });
  });

  it.each([
    ['10-bit 4:4:4', { bitdepth: 10 as const, chromaSubsampling: '4:4:4' }],
    ['8-bit 4:2:0', { bitdepth: 8 as const, chromaSubsampling: '4:2:0' }],
    ['12-bit 4:4:4', { bitdepth: 12 as const, chromaSubsampling: '4:4:4' }],
  ])('rewrites primaries and transfer to BT.2020 PQ without touching a pixel (%s)', async (_name, options) => {
    const source = await (await solid()).avif(options).toBuffer();
    const tagged = setAvifColour(source, CICP_PRIMARIES_BT2020, CICP_TRANSFER_PQ);
    expect(tagged.length).toBe(source.length);
    expect(readAvifColour(tagged)).toMatchObject({ primaries: 9, transfer: 16, matrix: 6 });
    const file = write('tagged.avif', tagged);
    expect(probe(file)).toMatchObject({ color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'smpte170m' });
    // The avifdec reference decoder reports the same description, and decodes the identical samples.
    const info = execFileSync('avifdec', ['--info', file], { encoding: 'utf8' });
    expect(info).toMatch(/Color Primaries\s*:\s*9\b/);
    expect(info).toMatch(/Transfer Char\.\s*:\s*16\b/);
    const original = await sharp(source).raw().toBuffer();
    expect(Buffer.compare(await sharp(tagged).raw().toBuffer(), original)).toBe(0);
    // Only the code point bits differ.
    let differing = 0;
    for (let i = 0; i < source.length; i += 1) if (source[i] !== tagged[i]) differing += 1;
    expect(differing).toBeLessThanOrEqual(2);
  });

  it('tags the primary item of a file with an alpha item and with an ICC profile', async () => {
    const withAlpha = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 0.5 } } })
      .avif({ bitdepth: 10 })
      .toBuffer();
    const tagged = setAvifColour(withAlpha, CICP_PRIMARIES_BT2020, CICP_TRANSFER_PQ);
    expect(probe(write('alpha.avif', tagged))).toMatchObject({ color_primaries: 'bt2020', color_transfer: 'smpte2084' });
    expect((await sharp(tagged).metadata()).hasAlpha).toBe(true);

    const icc = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 200, b: 90 } } })
      .withIccProfile('p3')
      .avif()
      .toBuffer();
    expect(readAvifColour(setAvifColour(icc, CICP_PRIMARIES_BT2020, CICP_TRANSFER_PQ))).toMatchObject({ primaries: 9, transfer: 16 });
  });

  it('refuses files it cannot read or rewrite with a typed error', () => {
    const cases: Array<[string, Buffer, RegExp]> = [
      ['not an AVIF', Buffer.from('definitely not an image, just text'), /^Invalid AVIF: box "nite" runs past its parent/],
      ['a truncated file', plain.subarray(0, 100), /runs past/],
      ['an empty buffer', Buffer.alloc(0), /ftyp/],
    ];
    for (const [, buffer, message] of cases) {
      expect(() => readAvifColour(buffer)).toThrow(message);
      expect(() => readAvifColour(buffer)).toThrow(ColourTagError);
    }
    // a box declaring more children than the limit
    const many = Buffer.concat([plain.subarray(0, 28), Buffer.alloc((AVIF_MAX_BOXES + 8) * 8)]);
    many.writeUInt32BE(8, 28);
    for (let i = 0; i <= AVIF_MAX_BOXES + 6; i += 1) {
      many.writeUInt32BE(8, 28 + i * 8);
      many.write('free', 32 + i * 8, 'latin1');
    }
    expect(() => readAvifColour(many)).toThrow(new RegExp(`more than ${AVIF_MAX_BOXES} boxes`));
    expect(new ColourTagError('x')).toBeInstanceOf(ConversionFailedError);
  });
});

describe.skipIf(skipWithoutTools('ffprobe', 'exiftool', 'identify'))('PNG cICP chunk', () => {
  async function png(): Promise<Buffer> {
    return (await solid()).png().toBuffer();
  }

  it('writes a chunk that exiftool, ffprobe and pngcheck read, and the image still decodes identically', async () => {
    const source = await png();
    const tagged = writePngCicp(source, { primaries: CICP_PRIMARIES_BT2020, transfer: CICP_TRANSFER_PQ, matrix: CICP_MATRIX_IDENTITY, fullRange: true });
    const file = write('tagged.png', tagged);
    expect(readPngCicp(tagged)).toEqual({ primaries: 9, transfer: 16, matrix: 0, fullRange: true });
    expect(readPngCicp(source)).toBeNull();
    const exif = execFileSync('exiftool', ['-s3', '-PNG-cICP:ColorPrimaries', '-PNG-cICP:TransferCharacteristics', '-PNG-cICP:VideoFullRangeFlag', file], { encoding: 'utf8' });
    expect(exif).toMatch(/BT\.2020/);
    expect(exif).toMatch(/SMPTE ST 2084/);
    expect(probe(file)).toMatchObject({ color_primaries: 'bt2020', color_transfer: 'smpte2084' });
    // This pngcheck predates cICP and flags the chunk as unknown, but it still checks every CRC and the chunk order.
    const check = spawnSync('pngcheck', ['-v', file], { encoding: 'utf8' }).stdout;
    expect(check).toMatch(/chunk cICP at offset 0x00025, length 4: {2}illegal \(unless recently approved\) unknown, public chunk/);
    expect(check).not.toMatch(/CRC error|invalid chunk|out of order/i);
    expect(Buffer.compare(await sharp(tagged).raw().toBuffer(), await sharp(source).raw().toBuffer())).toBe(0);
  });

  it('places the chunk before the image data and replaces an existing one', async () => {
    const once = writePngCicp(await png(), { primaries: 1, transfer: 13, matrix: 0, fullRange: true });
    const twice = writePngCicp(once, { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
    expect(twice.indexOf(Buffer.from('cICP'))).toBeLessThan(twice.indexOf(Buffer.from('IDAT')));
    expect(twice.indexOf(Buffer.from('cICP'))).toBe(twice.lastIndexOf(Buffer.from('cICP')));
    expect(readPngCicp(twice)).toMatchObject({ primaries: 9, transfer: 16 });
  });

  it('rejects input that is not a PNG, and a chunk of the wrong size', async () => {
    expect(() => writePngCicp(Buffer.from('GIF89a......'), { primaries: 1, transfer: 13, matrix: 0, fullRange: true })).toThrow(/not a PNG/);
    const tagged = writePngCicp(await png(), { primaries: 1, transfer: 13, matrix: 0, fullRange: true });
    const at = tagged.indexOf(Buffer.from('cICP')) - 4;
    const broken = Buffer.from(tagged);
    broken.writeUInt32BE(5, at);
    expect(() => readPngCicp(broken)).toThrow(/cICP chunk has 5 bytes/);
  });
});
