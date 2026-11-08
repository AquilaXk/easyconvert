import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { withExifChunk } from '../src/lib/conversions/image-jxl-exif';

/**
 * The EXIF block that `djxl` writes into a PNG as a `Raw profile type exif` text chunk is copied into an `eXIf` chunk with its
 * Orientation set to 1. The blocks here are written from the layouts of TIFF 6.0 and PNG 1.5 (chunk, CRC); the chunk djxl writes is read
 * from real files in image-jxl-decode.test.ts.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A little-endian TIFF block with the Orientation entry (and nothing else) in its first directory. */
function tiffWithOrientation(orientation: number, order: 'II' | 'MM' = 'II'): Buffer {
  const little = order === 'II';
  const out = Buffer.alloc(8 + 2 + 12 + 4);
  out.write(order, 0, 'latin1');
  if (little) out.writeUInt16LE(42, 2);
  else out.writeUInt16BE(42, 2);
  if (little) out.writeUInt32LE(8, 4);
  else out.writeUInt32BE(8, 4);
  const put16 = (value: number, at: number) => (little ? out.writeUInt16LE(value, at) : out.writeUInt16BE(value, at));
  put16(1, 8);
  put16(0x0112, 10);
  put16(3, 12);
  if (little) out.writeUInt32LE(1, 14);
  else out.writeUInt32BE(1, 14);
  put16(orientation, 18);
  return out;
}

/** The text of an ImageMagick raw profile: a line break, the name, the length padded to 8 columns, and the bytes in hexadecimal lines of 72 digits. */
function rawProfile(bytes: Buffer): string {
  const hex = bytes.toString('hex').replace(/(.{72})/g, '$1\n');
  return `\nexif\n${String(bytes.length).padStart(8)}\n${hex}\n`;
}

function textChunk(keyword: string, text: string, method = 0): Buffer {
  return chunk('zTXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, method]), zlib.deflateSync(Buffer.from(text, 'latin1'))]));
}

async function onePixel(): Promise<Buffer[]> {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer();
  // IHDR, IDAT, IEND of a real PNG, so that the picture round-trips through the image library.
  const chunks: Buffer[] = [];
  for (let offset = PNG_SIGNATURE.length; offset < png.length; offset += 12 + png.readUInt32BE(offset)) chunks.push(png.subarray(offset, offset + 12 + png.readUInt32BE(offset)));
  return chunks;
}

const typeOf = (png: Buffer, from: number): string[] => {
  const types: string[] = [];
  for (let offset = PNG_SIGNATURE.length; offset < png.length; offset += 12 + png.readUInt32BE(offset)) types.push(png.toString('latin1', offset + 4, offset + 8));
  return types.slice(from);
};

function eXIfOf(png: Buffer): Buffer | undefined {
  for (let offset = PNG_SIGNATURE.length; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
    if (png.toString('latin1', offset + 4, offset + 8) === 'eXIf') return png.subarray(offset + 8, offset + 8 + png.readUInt32BE(offset));
  }
  return undefined;
}

async function pngWith(...extra: Buffer[]): Promise<Buffer> {
  const [ihdr, ...rest] = await onePixel();
  return Buffer.concat([PNG_SIGNATURE, ihdr, ...extra, ...rest]);
}

describe('the EXIF block of a decoded picture', () => {
  it.each([
    ['a little-endian block', tiffWithOrientation(6, 'II')],
    ['a big-endian block', tiffWithOrientation(5, 'MM')],
    ['a block that starts with the Exif prefix of a newer djxl', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffWithOrientation(8)])],
    ['a block behind the zero offset field of the Exif box, as libjxl 0.7 writes it', Buffer.concat([Buffer.alloc(4), tiffWithOrientation(5, 'MM')])],
    ['a block behind an offset field that skips four bytes', Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('skip'), tiffWithOrientation(6)])],
  ])('is stored as an eXIf chunk before the picture data, with Orientation 1: %s', async (_label, exif) => {
    const out = withExifChunk(await pngWith(textChunk('Raw profile type exif', rawProfile(exif))));
    expect(typeOf(out, 0)).toEqual(['IHDR', 'zTXt', 'pHYs', 'eXIf', 'IDAT', 'IEND']);
    const stored = eXIfOf(out) as Buffer;
    expect(stored.toString('latin1', 0, 2)).toMatch(/^(II|MM)$/);
    const little = stored.toString('latin1', 0, 2) === 'II';
    expect(little ? stored.readUInt16LE(18) : stored.readUInt16BE(18)).toBe(1);
    expect(stored.length).toBe(tiffWithOrientation(1).length);
    // The chunk is well formed: the image library reads the picture and the block back.
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.exif !== undefined]).toEqual([2, 2, true]);
  });

  it('is left as it is when the picture has an eXIf chunk already, no picture data, or no profile', async () => {
    const profile = textChunk('Raw profile type exif', rawProfile(tiffWithOrientation(6)));
    const withChunk = await pngWith(chunk('eXIf', tiffWithOrientation(3)), profile);
    expect(withExifChunk(withChunk)).toBe(withChunk);
    const chunks = await onePixel();
    const noData = Buffer.concat([PNG_SIGNATURE, chunks[0], profile, chunks[chunks.length - 1]]);
    expect(withExifChunk(noData)).toBe(noData);
    const plain = await pngWith();
    expect(withExifChunk(plain)).toBe(plain);
    const other = await pngWith(textChunk('Raw profile type xmp', rawProfile(tiffWithOrientation(6))));
    expect(withExifChunk(other)).toBe(other);
  });

  it.each([
    ['a length that is not the length of the bytes', `\nexif\n${String(99).padStart(8)}\n${tiffWithOrientation(6).toString('hex')}\n`],
    ['an odd number of digits', `\nexif\n${String(21).padStart(8)}\n${tiffWithOrientation(6).toString('hex')}0\n`],
    ['a character that is no digit', `\nexif\n${String(22).padStart(8)}\n${tiffWithOrientation(6).toString('hex').replace(/^../, 'zz')}\n`],
    ['an offset that leads to no TIFF header', `\nexif\n${String(22).padStart(8)}\n00000040${tiffWithOrientation(6).toString('hex')}\n`],
    ['bytes of a prefix and no TIFF header', `\nexif\n${String(14).padStart(8)}\n${Buffer.from('Exif\0\0notatiff').toString('hex')}\n`],
    ['bytes too few for a TIFF header', `\nexif\n${String(4).padStart(8)}\n49492a00\n`],
    ['another profile name', `\nxmp\n${String(22).padStart(8)}\n${tiffWithOrientation(6).toString('hex')}\n`],
    ['no profile at all', 'text'],
  ])('is left as it is for %s', async (_label, text) => {
    const png = await pngWith(textChunk('Raw profile type exif', text));
    expect(withExifChunk(png)).toBe(png);
  });

  it('is left as it is when the text chunk is not zlib data, or uses another compression method', async () => {
    const broken = chunk('zTXt', Buffer.concat([Buffer.from('Raw profile type exif'), Buffer.from([0, 0]), Buffer.from('not zlib data')]));
    const png = await pngWith(broken);
    expect(withExifChunk(png)).toBe(png);
    const method = await pngWith(textChunk('Raw profile type exif', rawProfile(tiffWithOrientation(6)), 1));
    expect(withExifChunk(method)).toBe(method);
    const noKeyword = await pngWith(chunk('zTXt', Buffer.from('no terminator')));
    expect(withExifChunk(noKeyword)).toBe(noKeyword);
  });

  it('is left as it is when the text inflates past the bound', async () => {
    const huge = Buffer.alloc(3 * 1024 * 1024, 0x30);
    const png = await pngWith(chunk('zTXt', Buffer.concat([Buffer.from('Raw profile type exif'), Buffer.from([0, 0]), zlib.deflateSync(huge)])));
    expect(withExifChunk(png)).toBe(png);
  });

  it('is left as it is when a chunk runs past the end of the file', async () => {
    const png = await pngWith(textChunk('Raw profile type exif', rawProfile(tiffWithOrientation(6))));
    const cut = png.subarray(0, png.length - 20);
    expect(withExifChunk(cut)).toBe(cut);
  });
});
