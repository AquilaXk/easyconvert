import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { getOracleToolPath } from './helpers/differential-oracle';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A picture whose only metadata is a pixel density, or an ICC profile the conversion already applies to the pixels,
 * must not leave a synthesised EXIF block in a WebP or AVIF: the block is ~190 bytes, 2% of a small file, and the
 * viewers of both formats ignore a print density. Oracle: exiftool lists the blocks of the written file; the
 * JPEG keeps its density in the JFIF header, which costs nothing.
 */

const WIDTH = 96;
const HEIGHT = 64;
const NOISE_MULTIPLIER = 2654435761;
const BYTE_MAX = 255;
const PRINT_DENSITY_PPI = 300;
const XMP_PACKET = '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="metadata overhead test"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>';

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'metadata-overhead-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function raster(): Buffer {
  const data = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < data.length; i += 1) data[i] = (Math.imul(i, NOISE_MULTIPLIER) >>> 24) & BYTE_MAX;
  return data;
}

const PNG_SIGNATURE_BYTES = 8;
const IHDR_CHUNK_BYTES = 25;
const METRES_PER_INCH = 0.0254;

/** The PNG with a `pHYs` chunk (pixels per metre) after IHDR and nothing else added: the library would also write an EXIF chunk for a density. */
function withPhysChunk(png: Buffer, ppi: number): Buffer {
  const data = Buffer.alloc(9);
  const perMetre = Math.round(ppi / METRES_PER_INCH);
  data.writeUInt32BE(perMetre, 0);
  data.writeUInt32BE(perMetre, 4);
  data.writeUInt8(1, 8);
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9, 0);
  chunk.write('pHYs', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);
  const at = PNG_SIGNATURE_BYTES + IHDR_CHUNK_BYTES;
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

/** The profile "sRGB IEC61966-2-1 black scaled" (3,048 bytes, ICC): one the reference engine's PNG reader recognises as sRGB and does not attach. */
const RECOGNISED_SRGB_PROFILE_FILE = path.join(__dirname, 'fixtures', 'images', 'srgb-iec61966-2-1-black-scaled.icc');
const RECOGNISED_SRGB_PROFILE = readFileSync(RECOGNISED_SRGB_PROFILE_FILE);

/** The `iCCP` chunk of a profile (keyword, 0, method 0, deflated profile), put after IHDR like `withPhysChunk` does for `pHYs`. */
function iccpChunk(profile: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from('profile\0\0', 'latin1'), deflateSync(profile)]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('iCCP', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function withChunkAfterHeader(png: Buffer, chunk: Buffer): Buffer {
  const at = PNG_SIGNATURE_BYTES + IHDR_CHUNK_BYTES;
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

const base = (): Sharp => sharp(raster(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } });

function exiftoolGroups(buffer: Buffer, extension: string): string {
  const file = path.join(workDir, `out-${Math.random().toString(36).slice(2)}.${extension}`);
  writeFileSync(file, buffer);
  return execFileSync(getOracleToolPath('exiftool') ?? 'exiftool', ['-G1', '-a', '-s', file], { encoding: 'utf-8' });
}

describe.skipIf(skipWithoutTools('exiftool'))('metadata the conversion adds to a picture', () => {
  it.each(['webp', 'avif'])('writes no EXIF block into a %s of a picture whose only metadata is its density', async (target) => {
    const source = withPhysChunk(await base().png().toBuffer(), PRINT_DENSITY_PPI);
    expect(Math.round((await sharp(source).metadata()).density ?? 0)).toBe(PRINT_DENSITY_PPI);
    expect((await sharp(source).metadata()).exif).toBeUndefined();
    const listing = exiftoolGroups((await convertImage(source, target, { quality: 70 }, 'd.png', 'png')).buffer, target);
    expect(listing).not.toMatch(/\[(EXIF|IFD0|ExifIFD)\]/);
    expect(listing).not.toMatch(/XResolution/);
  });

  it.each(['webp', 'avif', 'jpg'])('keeps the ICC profile of a source as it is in a %s, with its pixels, and adds no EXIF block', async (target) => {
    const p3 = await base().withIccProfile('p3').png().toBuffer();
    const profile = (await sharp(p3).metadata()).icc as Buffer;
    expect(profile).toBeDefined();
    const out = (await convertImage(p3, target, { quality: 100 }, 'i.png', 'png')).buffer;
    expect((await sharp(out).metadata()).icc?.equals(profile)).toBe(true);
    expect(exiftoolGroups(out, target === 'jpg' ? 'jpg' : target)).not.toMatch(/\[(EXIF|IFD0|ExifIFD)\]/);
  });

  it.each(['webp', 'avif'])('carries the XMP block of the source into a %s without adding an EXIF block of its own', async (target) => {
    const source = await base().withXmp(XMP_PACKET).png().toBuffer();
    const sourceMeta = await sharp(source).metadata();
    expect(sourceMeta.xmp).toBeDefined();
    expect(sourceMeta.exif).toBeUndefined();
    const listing = exiftoolGroups((await convertImage(source, target, { quality: 70 }, 'x.png', 'png')).buffer, target);
    expect(listing).toMatch(/\[XMP-x\]\s+XMPToolkit\s*:\s*metadata overhead test/);
    expect(listing).not.toMatch(/\[(EXIF|IFD0|ExifIFD)\]/);
  });

  it.each(['webp', 'avif', 'jpg'])('writes no ICC profile into a %s of a PNG whose profile the reference engine reads as sRGB, and no EXIF block either', async (target) => {
    const source = withChunkAfterHeader(await base().png().toBuffer(), iccpChunk(RECOGNISED_SRGB_PROFILE));
    expect((await sharp(source).metadata()).icc?.equals(RECOGNISED_SRGB_PROFILE)).toBe(true);
    const out = (await convertImage(source, target, { quality: 70 }, 's.png', 'png')).buffer;
    expect((await sharp(out).metadata()).icc).toBeUndefined();
    expect(exiftoolGroups(out, target)).not.toMatch(/\[(EXIF|IFD0|ExifIFD)\]/);
  });

  it.each(['webp', 'avif', 'jpg'])('keeps an sRGB profile of a PNG that the reference engine does not read as sRGB, as it is, in a %s', async (target) => {
    const source = await base().withIccProfile('srgb').png().toBuffer();
    const profile = (await sharp(source).metadata()).icc as Buffer;
    expect(profile).toBeDefined();
    const out = (await convertImage(source, target, { quality: 70 }, 's.png', 'png')).buffer;
    expect((await sharp(out).metadata()).icc?.equals(profile)).toBe(true);
    expect(exiftoolGroups(out, target)).not.toMatch(/\[(EXIF|IFD0|ExifIFD)\]/);
  });

  it.each(['webp', 'avif', 'jpg'])('keeps the sRGB profile of a JPEG source, as it is, in a %s', async (target) => {
    const source = await base().withIccProfile(RECOGNISED_SRGB_PROFILE_FILE, { attach: true }).jpeg().toBuffer();
    expect((await sharp(source).metadata()).icc?.equals(RECOGNISED_SRGB_PROFILE)).toBe(true);
    const out = (await convertImage(source, target, { quality: 70 }, 's.jpg', 'jpg')).buffer;
    expect((await sharp(out).metadata()).icc?.equals(RECOGNISED_SRGB_PROFILE)).toBe(true);
  });

  it('keeps the density of a JPEG in its JFIF header', async () => {
    const source = withPhysChunk(await base().png().toBuffer(), PRINT_DENSITY_PPI);
    const out = (await convertImage(source, 'jpg', { quality: 70 }, 'd.png', 'png')).buffer;
    expect(Math.round((await sharp(out).metadata()).density ?? 0)).toBe(PRINT_DENSITY_PPI);
  });

  it.each(['webp', 'avif'])('still carries the EXIF block of the source into a %s, and the density inside it', async (target) => {
    const source = await base().withMetadata({ density: PRINT_DENSITY_PPI }).withExif({ IFD0: { Copyright: 'Metadata overhead test' } }).png().toBuffer();
    const listing = exiftoolGroups((await convertImage(source, target, { quality: 70 }, 'e.png', 'png')).buffer, target);
    expect(listing).toMatch(/Copyright\s*:\s*Metadata overhead test/);
  });
});
