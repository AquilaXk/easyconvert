import { crc32, deflateSync } from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';
import { hasValidChunkChecksums, metadataChunksOf, withMetadataOf } from '../bench/png-metadata';

/**
 * The reference encoders of the image benchmark get the decoded pixels with the EXIF, XMP and ICC blocks of the source, and nothing
 * else of it (a `gAMA` chunk would change the pixels an encoder reads). Oracle: the library reads the blocks back from the
 * assembled file, and decodes its pixels, which must be those of the decoded copy.
 */

const SIDE = 12;
const XMP_PACKET = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>';

function pixels(): Buffer {
  const raw = Buffer.alloc(SIDE * SIDE * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37) & 0xff;
  return raw;
}

const base = (): Sharp => sharp(pixels(), { raw: { width: SIDE, height: SIDE, channels: 3 } });

/** A PNG with an `iCCP` chunk holding `profile` (not a real profile: the benchmark reads only its text) inserted after IHDR. */
function withProfileChunk(png: Buffer, profile: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from('prof\0\0', 'latin1'), deflateSync(profile)]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('iCCP', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

describe('metadata of a PNG for the reference encoders', () => {
  it('leaves out the usual sRGB profile, which the reference service reads as incorrect, and keeps any other', async () => {
    const decoded = await base().png().toBuffer();
    const rejected = withProfileChunk(decoded, Buffer.from('....desc....sRGB IEC61966-2.1....'));
    const other = withProfileChunk(decoded, Buffer.from('....desc....Display P3....'));
    expect(withMetadataOf(decoded, rejected).includes(Buffer.from('iCCP'))).toBe(false);
    const kept = withMetadataOf(decoded, other);
    expect(kept.includes(Buffer.from('iCCP'))).toBe(true);
    expect(hasValidChunkChecksums(kept)).toBe(true);
  });

  it('puts the EXIF, XMP and ICC blocks of the original into the decoded copy, with the pixels of the copy and valid checksums', async () => {
    const original = await base().withExif({ IFD0: { Copyright: 'reference test' } }).withXmp(XMP_PACKET).png().toBuffer();
    const decoded = await base().png().toBuffer();
    expect((await sharp(decoded).metadata()).exif).toBeUndefined();
    expect((await sharp(decoded).metadata()).xmp).toBeUndefined();
    const assembled = withMetadataOf(decoded, original);
    expect(hasValidChunkChecksums(assembled)).toBe(true);
    const meta = await sharp(assembled).metadata();
    expect(meta.exif?.toString('latin1')).toContain('reference test');
    expect(meta.xmp?.toString('utf8')).toContain('adobe:ns:meta');
    expect((await sharp(assembled).raw().toBuffer()).equals(pixels())).toBe(true);
  });

  it('carries the profile of the original, and no profile, gamma or density chunk of the decoded copy: the pixels an encoder reads are the pixels the rows are scored against', async () => {
    const original = await base().withIccProfile('p3').withExif({ IFD0: { Copyright: 'x' } }).png().toBuffer();
    const originalProfile = (await sharp(original).metadata()).icc;
    expect(originalProfile).toBeDefined();
    // A decoder may carry a profile into the copy it writes, or another one.
    const decoded = await base().withIccProfile('srgb').png().toBuffer();
    expect((await sharp(decoded).metadata()).icc?.equals(originalProfile as Buffer)).toBe(false);
    const assembled = withMetadataOf(decoded, original);
    const meta = await sharp(assembled).metadata();
    expect(meta.icc?.equals(originalProfile as Buffer)).toBe(true);
    expect(meta.exif?.toString('latin1')).toContain('x');
    for (const chunk of ['gAMA', 'pHYs', 'sRGB']) expect(assembled.includes(Buffer.from(chunk)), chunk).toBe(false);
    // The pixel data is the decoded copy's, byte for byte (reading it through the profile would convert it).
    const idat = (png: Buffer): Buffer => png.subarray(png.indexOf(Buffer.from('IDAT')) - 4, png.indexOf(Buffer.from('IEND')) - 4);
    expect(idat(assembled).equals(idat(decoded))).toBe(true);
  });

  it('writes the pixels alone when the original carries no block', async () => {
    const decoded = await base().withIccProfile('srgb').png().toBuffer();
    const original = await base().png().toBuffer();
    expect(metadataChunksOf(original)).toEqual([]);
    const assembled = withMetadataOf(decoded, original);
    expect(hasValidChunkChecksums(assembled)).toBe(true);
    expect((await sharp(assembled).metadata()).hasProfile).toBe(false);
    expect((await sharp(assembled).raw().toBuffer()).equals(pixels())).toBe(true);
  });

  it('detects a chunk whose checksum is wrong', async () => {
    const png = await base().png().toBuffer();
    const damaged = Buffer.from(png);
    damaged[damaged.length - 20] ^= 0xff;
    expect(hasValidChunkChecksums(png)).toBe(true);
    expect(hasValidChunkChecksums(damaged)).toBe(false);
  });
});
