import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { outputProblem } from '../bench/realworld/output-check';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { assertNotSpoofedFile, FileExtensionSpoofError, isFormatCompatibleWithMagicBytes, sniffMimeTypeFromMagicBytes } from '../src/lib/registry';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildPatchUltraHdr } from './helpers/hdr-test-images';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * The signatures of three image formats the spoof check refused although the files are what their names say (#783):
 * compressed SVG (RFC 1952 gzip member), Adobe Illustrator artwork (PDF-compatible, or PostScript with the Illustrator
 * prolog) and HEIF (ISO/IEC 23008-12 brands). Each accepted case is a real file or a header written from the layout in
 * the specification; each refused case is a file of another kind, or a header the specification does not allow. An Ultra HDR
 * image is a JPEG, so its output is judged as one (the real-world run called every Ultra HDR output "bad").
 */

const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
const FTYP_HEADER_BYTES = 16;
const BRAND_BYTES = 4;
const GZIP_FLAGS_OFFSET = 3;
const GZIP_METHOD_OFFSET = 2;
const FIRST_RESERVED_GZIP_FLAG = 0x20;

function ftypBox(majorBrand: string, compatibleBrands: readonly string[]): Buffer {
  const box = Buffer.alloc(FTYP_HEADER_BYTES + compatibleBrands.length * BRAND_BYTES);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'ascii');
  box.write(majorBrand, 8, 'ascii');
  compatibleBrands.forEach((brand, index) => box.write(brand, FTYP_HEADER_BYTES + index * BRAND_BYTES, 'ascii'));
  return box;
}

describe('compressed SVG (.svgz)', () => {
  it('accepts a gzip member under the .svgz name', () => {
    const bytes = zlib.gzipSync(Buffer.from(SVG));
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe('application/gzip');
    expect(isFormatCompatibleWithMagicBytes(bytes, 'svgz')).toBe(true);
    expect(() => assertNotSpoofedFile(bytes, 'svgz', 'drawing.svgz')).not.toThrow();
  });

  it.for(['okular-checkmark.svgz', 'okular-hisc-apps-okular.svgz', 'tika-testsvg.svgz'])('accepts the real file %s', async (id, ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'svgz')).toBe(true);
  });

  it('still refuses a gzip member under a name of another format', () => {
    const bytes = zlib.gzipSync(Buffer.from(SVG));
    expect(isFormatCompatibleWithMagicBytes(bytes, 'png')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'svg')).toBe(false);
  });

  it('refuses bytes that are not gzip under the .svgz name', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    expect(isFormatCompatibleWithMagicBytes(png, 'svgz')).toBe(false);
    expect(() => assertNotSpoofedFile(png, 'svgz', 'drawing.svgz')).toThrow(FileExtensionSpoofError);
  });

  it('refuses a gzip header that RFC 1952 does not allow', () => {
    const notDeflate = zlib.gzipSync(Buffer.from(SVG));
    notDeflate[GZIP_METHOD_OFFSET] = 7;
    expect(isFormatCompatibleWithMagicBytes(notDeflate, 'svgz')).toBe(false);

    const reservedFlag = zlib.gzipSync(Buffer.from(SVG));
    reservedFlag[GZIP_FLAGS_OFFSET] |= FIRST_RESERVED_GZIP_FLAG;
    expect(isFormatCompatibleWithMagicBytes(reservedFlag, 'svgz')).toBe(false);

    const truncated = zlib.gzipSync(Buffer.from(SVG)).subarray(0, 9);
    expect(isFormatCompatibleWithMagicBytes(truncated, 'svgz')).toBe(false);
  });
});

describe('Adobe Illustrator artwork (.ai)', () => {
  const postscript = (prolog: string): Buffer => Buffer.from(`%!PS-Adobe-3.0 EPSF-3.0\n${prolog}\n%%EndComments\n`, 'latin1');

  it('accepts a PDF-compatible file', () => {
    expect(isFormatCompatibleWithMagicBytes(Buffer.from('%PDF-1.6\n%\xe2\xe3\xcf\xd3\n', 'latin1'), 'ai')).toBe(true);
  });

  it.each([
    ['the creator comment', '%%Creator: Adobe Illustrator(R) 8.0'],
    ['the format comment', '%AI5_FileFormat 3'],
    ['the procedure set', '%%+ procset Adobe_Illustrator_AI5 1.2 0'],
  ])('accepts a PostScript file with %s of the Illustrator prolog', (_label, prolog) => {
    const bytes = postscript(prolog);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'ai')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'eps')).toBe(true);
  });

  it('accepts the real PostScript-based file', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'tika-testai_ps.ai');
    expect(sniffMimeTypeFromMagicBytes(sample.bytes)).toBe('application/postscript');
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, 'ai')).toBe(true);
  });

  it('refuses a PostScript file without the Illustrator prolog', () => {
    const bytes = postscript('%%Creator: dvips(k) 5.998\n%%Title: notes');
    expect(isFormatCompatibleWithMagicBytes(bytes, 'ai')).toBe(false);
    expect(() => assertNotSpoofedFile(bytes, 'ai', 'art.ai')).toThrow(FileExtensionSpoofError);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'ps')).toBe(true);
  });

  it('refuses an Illustrator marker that sits past the prolog', () => {
    const bytes = postscript(`${'%'.repeat(9000)}\n%%Creator: Adobe Illustrator(R) 8.0`);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'ai')).toBe(false);
  });

  it('refuses other formats under the .ai name', () => {
    expect(isFormatCompatibleWithMagicBytes(zlib.gzipSync(Buffer.from(SVG)), 'ai')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(ftypBox('isom', ['isom']), 'ai')).toBe(false);
  });
});

describe('HEIF brands (.heif, .heic)', () => {
  it.each([
    ['mif1', ['mif1', 'heic'], 'image/heic'],
    ['mif2', ['mif2', 'miaf'], 'image/heif'],
    ['mif3', ['mif3', 'heic'], 'image/heic'],
    ['mif3', ['mif3', 'miaf'], 'image/heif'],
  ] as const)('sniffs major brand %s with compatible brands %j as %s', (major, compatible, expected) => {
    const bytes = ftypBox(major, compatible);
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe(expected);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'heif')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'heic')).toBe(true);
  });

  it.for(['libheif-lightning_mini.heif', 'libheif-uncompressed_comp_rgb_tiled_row_tile_align.heif', 'pil-hopper.heif', 'nokiac-c002.heic'])('accepts the real file %s', async (id, ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    expect(isFormatCompatibleWithMagicBytes(sample.bytes, sample.format)).toBe(true);
  });

  it('still refuses video, AVIF and other kinds under the HEIF names', () => {
    expect(isFormatCompatibleWithMagicBytes(ftypBox('isom', ['isom', 'mif3']), 'heif')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(ftypBox('avif', ['mif1', 'avif']), 'heif')).toBe(false);
    expect(() => assertNotSpoofedFile(ftypBox('mp42', ['mp42', 'heic']), 'heic', 'photo.heic')).toThrow(FileExtensionSpoofError);
  });

  it('still refuses a HEIF image under the name of another format', () => {
    const bytes = ftypBox('mif3', ['mif3', 'heic']);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'mp4')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'png')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'avif')).toBe(false);
  });
});

describe('Ultra HDR images (.ultrahdr)', () => {
  it('are JPEG files: the independent builder\'s Ultra HDR image passes under both names', async () => {
    const bytes = await buildPatchUltraHdr();
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe('image/jpeg');
    expect(isFormatCompatibleWithMagicBytes(bytes, 'ultrahdr')).toBe(true);
    expect(isFormatCompatibleWithMagicBytes(bytes, 'jpg')).toBe(true);
  });

  it('are still refused when the bytes are another kind of file', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    expect(isFormatCompatibleWithMagicBytes(png, 'ultrahdr')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(ftypBox('isom', ['isom']), 'ultrahdr')).toBe(false);
    expect(() => assertNotSpoofedFile(png, 'ultrahdr', 'photo.ultrahdr')).toThrow(FileExtensionSpoofError);
  });

  const exiftool = getOracleToolPath('exiftool');
  const needsRawTools = skipUnless('dcraw_emu and exiftool', getOracleToolPath('dcraw_emu') !== null && exiftool !== null);
  it.skipIf(needsRawTools)('are what a DNG file converts to, with the gain map the format needs', { timeout: 120_000 }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'pix-xiaomi-mi8.dng');
    const result = await dispatchConversion(sample.bytes, 'dng', 'ultrahdr', {}, 'phone.dng');
    expect(await outputProblem(result.buffer, 'ultrahdr', os.tmpdir(), { mimeType: result.mimeType, pdfinfo: '', identify: '' })).toBeNull();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ultrahdr-out-')), 'out.jpg');
    fs.writeFileSync(file, result.buffer);
    try {
      const tags = execFileSync(exiftool as string, ['-G1', '-a', '-s', file], { encoding: 'utf8' });
      expect(tags).toMatch(/DirectorySemantic\s*: Primary/);
      expect(tags).toMatch(/DirectorySemantic\s*: GainMap/);
      expect(tags).toMatch(/NumberOfImages\s*: 2/);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
