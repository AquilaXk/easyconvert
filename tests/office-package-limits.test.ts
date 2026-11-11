import zlib from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripOfficeMacros } from '../src/lib/conversions/office-macro-strip';
import { MAX_PACKAGE_ENTRIES, openPackage } from '../src/lib/conversions/package-access';
import { assertOfficeEmbeddedImagesWithinLimit } from '../src/worker/office-input-checks';
import { ConversionFailedError, PayloadLimitError } from '../src/lib/types';

/**
 * What is checked about an office package before JSZip or the office suite reads it: the entries its end records declare (JSZip builds
 * an object for each), and every picture in it, however its part is named. A package that cannot be read is refused, not passed on.
 */

const HANG_GUARD_MS = 30_000;
vi.setConfig({ testTimeout: HANG_GUARD_MS });

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const ZIP64_END_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const END_BYTES = 22;
const SATURATED_16 = 0xffff;
const SATURATED_32 = 0xffffffff;

/** A ZIP64 file of `count` empty stored entries, written by hand: nothing reads its entries but the reader under test. */
function zipOfEmptyEntries(count: number): Buffer {
  const names = Array.from({ length: count }, (_, at) => Buffer.from(`p${at}`));
  const localSize = names.reduce((sum, name) => sum + LOCAL_HEADER_BYTES + name.length, 0);
  const centralSize = names.reduce((sum, name) => sum + CENTRAL_HEADER_BYTES + name.length, 0);
  const out = Buffer.alloc(localSize + centralSize + ZIP64_END_BYTES + ZIP64_LOCATOR_BYTES + END_BYTES);
  let at = 0;
  const offsets: number[] = [];
  for (const name of names) {
    offsets.push(at);
    out.writeUInt32LE(0x04034b50, at);
    out.writeUInt16LE(20, at + 4);
    out.writeUInt16LE(0x21, at + 12); // a valid DOS date
    out.writeUInt16LE(name.length, at + 26);
    name.copy(out, at + LOCAL_HEADER_BYTES);
    at += LOCAL_HEADER_BYTES + name.length;
  }
  const directoryStart = at;
  names.forEach((name, index) => {
    out.writeUInt32LE(0x02014b50, at);
    out.writeUInt16LE(20, at + 4);
    out.writeUInt16LE(20, at + 6);
    out.writeUInt16LE(0x21, at + 16);
    out.writeUInt16LE(name.length, at + 28);
    out.writeUInt32LE(offsets[index], at + 42);
    name.copy(out, at + CENTRAL_HEADER_BYTES);
    at += CENTRAL_HEADER_BYTES + name.length;
  });
  const zip64At = at;
  out.writeUInt32LE(0x06064b50, at);
  out.writeBigUInt64LE(BigInt(ZIP64_END_BYTES - 12), at + 4);
  out.writeUInt16LE(45, at + 12);
  out.writeUInt16LE(45, at + 14);
  out.writeBigUInt64LE(BigInt(count), at + 24);
  out.writeBigUInt64LE(BigInt(count), at + 32);
  out.writeBigUInt64LE(BigInt(centralSize), at + 40);
  out.writeBigUInt64LE(BigInt(directoryStart), at + 48);
  at += ZIP64_END_BYTES;
  out.writeUInt32LE(0x07064b50, at);
  out.writeBigUInt64LE(BigInt(zip64At), at + 8);
  out.writeUInt32LE(1, at + 16);
  at += ZIP64_LOCATOR_BYTES;
  out.writeUInt32LE(0x06054b50, at);
  out.writeUInt16LE(SATURATED_16, at + 8);
  out.writeUInt16LE(SATURATED_16, at + 10);
  out.writeUInt32LE(SATURATED_32, at + 12);
  out.writeUInt32LE(SATURATED_32, at + 16);
  return out;
}

/** A PNG whose header declares `side` x `side` pixels; only its header is read by the checks. */
async function pngOfSide(side: number): Promise<Buffer> {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  png.writeUInt32BE(side, 16);
  png.writeUInt32BE(side, 20);
  png.writeUInt32BE(zlib.crc32(png.subarray(12, 29)), 29);
  return png;
}

async function packageWith(parts: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  for (const [name, data] of Object.entries(parts)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the entries of a package', () => {
  const tooMany = zipOfEmptyEntries(MAX_PACKAGE_ENTRIES + 1);

  it('are counted from the end records before JSZip makes an object for each', async () => {
    const load = vi.spyOn(JSZip, 'loadAsync');
    await expect(openPackage(tooMany, 'DOCX')).rejects.toBeInstanceOf(PayloadLimitError);
    expect(load).not.toHaveBeenCalled();
  });

  it('are counted before the macro check opens the package', async () => {
    const load = vi.spyOn(JSZip, 'loadAsync');
    await expect(stripOfficeMacros(tooMany)).rejects.toBeInstanceOf(ConversionFailedError);
    expect(load).not.toHaveBeenCalled();
  });

  it('are counted before the picture check opens the package', async () => {
    const load = vi.spyOn(JSZip, 'loadAsync');
    await expect(assertOfficeEmbeddedImagesWithinLimit(tooMany)).rejects.toBeInstanceOf(PayloadLimitError);
    expect(load).not.toHaveBeenCalled();
  });

  it('may be as many as the limit', async () => {
    const zip = await openPackage(zipOfEmptyEntries(MAX_PACKAGE_ENTRIES), 'DOCX');
    expect(Object.keys(zip.files)).toHaveLength(MAX_PACKAGE_ENTRIES);
  });
});

describe('the picture check of an office package', () => {
  it('refuses a package that cannot be read, which the office suite might still open', async () => {
    const damaged = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]);
    await expect(assertOfficeEmbeddedImagesWithinLimit(damaged)).rejects.toThrow(/not a valid office package/);
  });

  it.each([
    ['a part of another name in the package', 'word/embeddings/oleObject1.bin'],
    ['a part with no extension outside any media folder', 'customXml/payload'],
    ['a part named as XML', 'word/theme/theme9.xml'],
  ])('refuses a picture over the pixel limit in %s', async (_what, name) => {
    const bomb = await packageWith({ [name]: await pngOfSide(40_000) });
    await expect(assertOfficeEmbeddedImagesWithinLimit(bomb)).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413 });
  });

  it('refuses a picture over the pixel limit in a media folder, as before', async () => {
    const bomb = await packageWith({ 'word/media/image1.png': await pngOfSide(40_000) });
    await expect(assertOfficeEmbeddedImagesWithinLimit(bomb)).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413 });
  });

  it('passes a package of small pictures and of parts that are no pictures', async () => {
    const fine = await packageWith({
      'word/document.xml': '<w:document/>',
      'word/embeddings/oleObject1.bin': await pngOfSide(10),
      'customXml/data.bin': Buffer.alloc(100, 1),
    });
    await expect(assertOfficeEmbeddedImagesWithinLimit(fine)).resolves.toBeUndefined();
  });
});
