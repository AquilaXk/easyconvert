import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FileExtensionSpoofError,
  assertNotSpoofedFile,
  isFormatCompatibleWithMagicBytes,
  sniffMimeTypeFromMagicBytes,
} from '../src/lib/registry';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * AVIF and HEIF files are ISO base media files: they open with an `ftyp` box (ISO/IEC 14496-12 section 4.3:
 * size, 'ftyp', major brand, minor version, compatible brands). The image brands come from ISO/IEC 23008-12
 * (HEIF: mif1, msf1, heic, heix, hevc, hevx, heim, heis) and the AV1 image file format (avif, avis). The boxes
 * below are assembled by hand from those layouts; the encoder files come from the reference encoders.
 */

const FTYP_HEADER_BYTES = 16;
const BRAND_BYTES = 4;
const Y4M_SIDE = 16;

function ftypBox(majorBrand: string, compatibleBrands: readonly string[]): Buffer {
  const box = Buffer.alloc(FTYP_HEADER_BYTES + compatibleBrands.length * BRAND_BYTES);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'ascii');
  box.write(majorBrand, 8, 'ascii');
  compatibleBrands.forEach((brand, index) => box.write(brand, FTYP_HEADER_BYTES + index * BRAND_BYTES, 'ascii'));
  return box;
}

describe('ISO base media image brands', () => {
  it.each([
    ['avif', ['mif1', 'avif', 'miaf', 'MA1B'], 'image/avif'],
    ['avis', ['avis', 'msf1', 'iso8', 'mif1', 'miaf'], 'image/avif'],
    ['mif1', ['mif1', 'avif', 'miaf'], 'image/avif'],
    ['heic', ['mif1', 'heic'], 'image/heic'],
    ['heix', ['mif1', 'heix'], 'image/heic'],
    ['mif1', ['mif1', 'heic', 'miaf'], 'image/heic'],
    ['msf1', ['msf1', 'hevc', 'iso8'], 'image/heic'],
    ['mif1', ['mif1', 'miaf'], 'image/heif'],
    ['msf1', ['msf1', 'iso8'], 'image/heif'],
  ] as const)('major brand %j with compatible brands %j sniffs as %s', (major, compatible, expected) => {
    expect(sniffMimeTypeFromMagicBytes(ftypBox(major, compatible))).toBe(expected);
  });

  it.each([
    ['isom', ['isom', 'iso2', 'avc1', 'mp41']],
    ['qt  ', ['qt  ']],
    ['3gp4', ['3gp4', 'isom']],
    ['crx ', ['crx ', 'isom']],
  ] as const)('a video file (major brand %j) still sniffs as video/mp4', (major, compatible) => {
    expect(sniffMimeTypeFromMagicBytes(ftypBox(major, compatible))).toBe('video/mp4');
  });

  it('reads compatible brands only inside the box and the buffer', () => {
    const declaredShort = ftypBox('mif1', ['mif1', 'avif']);
    declaredShort.writeUInt32BE(FTYP_HEADER_BYTES + BRAND_BYTES, 0);
    expect(sniffMimeTypeFromMagicBytes(declaredShort)).toBe('image/heif');

    const truncated = ftypBox('mif1', ['mif1', 'avif']).subarray(0, FTYP_HEADER_BYTES + BRAND_BYTES + 2);
    expect(sniffMimeTypeFromMagicBytes(truncated)).toBe('image/heif');
  });

  it.each([
    ['avif', ftypBox('avif', ['mif1', 'avif'])],
    ['heic', ftypBox('heic', ['mif1', 'heic'])],
    ['heif', ftypBox('heic', ['mif1', 'heic'])],
    ['heif', ftypBox('mif1', ['mif1'])],
    ['heic', ftypBox('mif1', ['mif1'])],
  ] as const)('a genuine image passes the gate under the .%s name', (extension, bytes) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, extension)).toBe(true);
  });

  it.each([
    ['mp4', ftypBox('avif', ['mif1', 'avif'])],
    ['png', ftypBox('avif', ['mif1', 'avif'])],
    ['heic', ftypBox('avif', ['mif1', 'avif'])],
    ['avif', ftypBox('heic', ['mif1', 'heic'])],
    ['mov', ftypBox('heic', ['mif1', 'heic'])],
    ['avif', ftypBox('isom', ['isom', 'mp41'])],
    ['heic', ftypBox('isom', ['isom', 'mp41'])],
  ] as const)('a mismatched file under the .%s name is still refused', (extension, bytes) => {
    expect(isFormatCompatibleWithMagicBytes(bytes, extension)).toBe(false);
    expect(() => assertNotSpoofedFile(bytes, extension, `upload.${extension}`)).toThrow(FileExtensionSpoofError);
  });
});

describe('files from the reference encoders', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-bmff-brands-'));
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

  /** A 16x16 4:2:0 YUV4MPEG2 frame with a luma ramp, written from the format's plain-text header layout. */
  function writeY4m(): string {
    const lumaBytes = Y4M_SIDE * Y4M_SIDE;
    const chromaBytes = (Y4M_SIDE / 2) * (Y4M_SIDE / 2);
    const luma = Buffer.alloc(lumaBytes);
    for (let i = 0; i < lumaBytes; i++) luma[i] = 16 + (i % 200);
    const chroma = Buffer.alloc(chromaBytes * 2, 128);
    const header = Buffer.from(`YUV4MPEG2 W${Y4M_SIDE} H${Y4M_SIDE} F25:1 Ip A1:1 C420jpeg\nFRAME\n`, 'ascii');
    const file = path.join(workDir, 'ramp.y4m');
    fs.writeFileSync(file, Buffer.concat([header, luma, chroma]));
    return file;
  }

  oracleTest('an AVIF file from the reference AVIF encoder is accepted as .avif and refused as .mp4', ['avifenc'], () => {
    const avifenc = requireOracleTool('avifenc');
    const output = path.join(workDir, 'ref.avif');
    execFileSync(avifenc, [writeY4m(), output], { stdio: 'pipe' });
    const bytes = fs.readFileSync(output);

    expect(bytes.toString('ascii', 4, 8)).toBe('ftyp');
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe('image/avif');
    expect(() => assertNotSpoofedFile(bytes, 'avif', 'ref.avif')).not.toThrow();
    expect(() => assertNotSpoofedFile(bytes, 'mp4', 'ref.mp4')).toThrow(FileExtensionSpoofError);
  });

  oracleTest('a HEIC file from the reference HEIF encoder is accepted as .heic and .heif and refused as .avif', ['heif-enc'], () => {
    const heifEnc = requireOracleTool('heif-enc');
    const output = path.join(workDir, 'ref.heic');
    execFileSync(heifEnc, [writeY4m(), '-o', output], { stdio: 'pipe' });
    const bytes = fs.readFileSync(output);

    expect(bytes.toString('ascii', 4, 8)).toBe('ftyp');
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe('image/heic');
    expect(() => assertNotSpoofedFile(bytes, 'heic', 'ref.heic')).not.toThrow();
    expect(() => assertNotSpoofedFile(bytes, 'heif', 'ref.heif')).not.toThrow();
    expect(() => assertNotSpoofedFile(bytes, 'avif', 'ref.avif')).toThrow(FileExtensionSpoofError);
  });

  oracleTest('an AVIF file from the reference HEIF encoder is accepted as .avif', ['heif-enc'], () => {
    const heifEnc = requireOracleTool('heif-enc');
    const output = path.join(workDir, 'ref-heif-enc.avif');
    execFileSync(heifEnc, ['-A', writeY4m(), '-o', output], { stdio: 'pipe' });
    const bytes = fs.readFileSync(output);

    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe('image/avif');
    expect(() => assertNotSpoofedFile(bytes, 'avif', 'ref-heif-enc.avif')).not.toThrow();
  });
});
