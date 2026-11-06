import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import { jpegXrSize, xpsImageFormat, xpsImagePixels } from '../src/lib/conversions/office/xps-image-header';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { ConversionFailedError } from '../src/lib/types';
import { JPEG_XR_SINGLE_PIXEL, JPEG_XR_WIDE_70000_BY_1, JPEG_XR_WINDOWED_37_BY_22 } from './helpers/jpegxr-samples';

/**
 * The pixels an image part of an XPS package costs, read from its header. The kinds of image are the ones GhostXPS tells apart
 * by their first bytes (GhostPDL xps/xpsimage.c `xps_decode_image`). The JPEG XR files are real ones, encoded by the JPEG XR
 * reference encoder and decoded by the reference decoder and GhostXPS to the sizes below (tests/helpers/jpegxr-samples.ts); the
 * other formats are written by the image library and their size is the one it was asked for.
 */

const PNG_SIGNATURE = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');

/** A PNG whose header declares `width` x `height` and whose pixel data is one empty chunk: enough for a header read, no picture. */
function pngDeclaring(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
}

async function rawImage(width: number, height: number): Promise<Sharp> {
  return sharp({ create: { width, height, channels: 3, background: '#808080' } });
}

describe('the kind of image an XPS part is', () => {
  it.each([
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), 'jpeg'],
    ['a PNG', Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4)]), 'png'],
    ['a JPEG XR file', Buffer.from('II\xbc\x01\x08\0\0\0', 'latin1'), 'jpegxr'],
    ['a little-endian TIFF', Buffer.from('II*\0\x08\0\0\0', 'latin1'), 'tiff'],
    ['a big-endian TIFF', Buffer.from('MM\0*\0\0\0\x08', 'latin1'), 'tiff'],
  ])('is told as %s by its first bytes', (_label, bytes, kind) => {
    expect(xpsImageFormat(bytes)).toBe(kind);
  });

  it.each([
    ['fewer than 8 bytes', Buffer.from([0xff, 0xd8, 0xff])],
    ['an ICC profile', Buffer.concat([Buffer.alloc(36), Buffer.from('acsp', 'latin1'), Buffer.alloc(16)])],
    ['text', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['a PNG signature cut short', PNG_SIGNATURE.subarray(0, 7)],
  ])('is no image for %s', (_label, bytes) => {
    expect(xpsImageFormat(bytes)).toBeUndefined();
  });
});

describe('the size of a JPEG XR image', () => {
  it('is the width and height the bitstream states, for a long header (past 65,536) and a short one', () => {
    expect(jpegXrSize(JPEG_XR_WIDE_70000_BY_1)).toEqual({ width: 70_000, height: 1 });
    expect(jpegXrSize(JPEG_XR_SINGLE_PIXEL)).toEqual({ width: 1, height: 1 });
  });

  it('is the size of the bitstream, not the 40 x 30 the container states for the same picture', () => {
    expect(jpegXrSize(JPEG_XR_WINDOWED_37_BY_22)).toEqual({ width: 37, height: 22 });
  });

  const directoryAt = (bytes: Buffer): number => bytes.readUInt32LE(4);
  const entryOf = (bytes: Buffer, tag: number): number => {
    const directory = directoryAt(bytes);
    for (let index = 0; index < bytes.readUInt16LE(directory); index += 1) {
      const at = directory + 2 + index * 12;
      if (bytes.readUInt16LE(at) === tag) return at;
    }
    throw new Error(`no entry ${tag}`);
  };
  const IMAGE_OFFSET = 0xbcc0;

  it.each([
    ['a container version above 1', (bytes: Buffer) => void (bytes[3] = 2)],
    ['a directory at an odd offset', (bytes: Buffer) => bytes.writeUInt32LE(directoryAt(bytes) + 1, 4)],
    ['a directory past the end of the file', (bytes: Buffer) => bytes.writeUInt32LE(bytes.length - 1, 4)],
    ['an image offset with a count of 2', (bytes: Buffer) => bytes.writeUInt32LE(2, entryOf(bytes, IMAGE_OFFSET) + 4)],
    ['an image offset of an unknown type', (bytes: Buffer) => bytes.writeUInt16LE(5, entryOf(bytes, IMAGE_OFFSET) + 2)],
    ['an image offset that does not lead to the signature', (bytes: Buffer) => bytes.writeUInt32LE(entryOf(bytes, IMAGE_OFFSET), entryOf(bytes, IMAGE_OFFSET) + 8)],
    ['an image offset past the end of the file', (bytes: Buffer) => bytes.writeUInt32LE(bytes.length, entryOf(bytes, IMAGE_OFFSET) + 8)],
    ['no image offset entry', (bytes: Buffer) => bytes.writeUInt16LE(0xbcc9, entryOf(bytes, IMAGE_OFFSET))],
    ['no directory at all', (bytes: Buffer) => bytes.writeUInt32LE(0, 4)],
    ['a directory whose entries run past the end of the file', (bytes: Buffer) => bytes.writeUInt16LE(0xffff, directoryAt(bytes))],
  ])('is refused for %s', (_label, damage) => {
    const bytes = Buffer.from(JPEG_XR_SINGLE_PIXEL);
    damage(bytes);
    expect(() => jpegXrSize(bytes)).toThrow(ConversionFailedError);
  });

  it('is refused when the file ends inside the codestream header', () => {
    const offset = JPEG_XR_SINGLE_PIXEL.readUInt32LE(entryOf(JPEG_XR_SINGLE_PIXEL, IMAGE_OFFSET) + 8);
    expect(() => jpegXrSize(JPEG_XR_SINGLE_PIXEL.subarray(0, offset + 14))).toThrow(/ends inside the codestream header/);
  });
});

/**
 * The renderer's container reader follows every directory of the chain, not only the first (GhostPDL jpegxr/cr_parse.c
 * `jxr_read_image_container`, lines 185 to 199, and `read_ifd`). Two of its readings never end: a directory whose next offset
 * leads back to a directory already read grows its table without end (line 195), and a USHORT array of more than 65,535 values
 * is read with a 16-bit counter that never reaches the count (line 1576). Measured with GhostXPS 10.07.1 on an XPS page
 * whose only brush names JPEG_XR_SINGLE_PIXEL with its next-directory offset pointed at its own directory: the unchanged file
 * drew in under a second (exit 0), the looped one was still running when `timeout 20` stopped it (exit 124).
 */
describe('the directory chain of a JPEG XR container', () => {
  const ENTRY_BYTES = 12;
  const TYPE_USHORT = 3;
  const TYPE_ULONG = 4;
  const TYPE_URATIONAL = 5;
  const sampleDirectory = JPEG_XR_SINGLE_PIXEL.readUInt32LE(4);
  /** Where the first directory keeps the offset of the next one: after its count and its entries. */
  const nextOffsetAt = sampleDirectory + 2 + JPEG_XR_SINGLE_PIXEL.readUInt16LE(sampleDirectory) * ENTRY_BYTES;

  function entry(tag: number, type: number, count: number, value: number): Buffer {
    const bytes = Buffer.alloc(ENTRY_BYTES);
    bytes.writeUInt16LE(tag, 0);
    bytes.writeUInt16LE(type, 2);
    bytes.writeUInt32LE(count, 4);
    bytes.writeUInt32LE(value, 8);
    return bytes;
  }

  /** A directory of `entries`, its next-directory offset `next`. */
  function directory(entries: readonly Buffer[], next: number): Buffer {
    const head = Buffer.alloc(2);
    head.writeUInt16LE(entries.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(next);
    return Buffer.concat([head, ...entries, tail]);
  }

  /** The sample with the directories of `chain` after its end (the first one linked from the sample's own directory), at even offsets. */
  function withChain(chain: readonly Buffer[]): Buffer {
    const pieces: Buffer[] = [Buffer.from(JPEG_XR_SINGLE_PIXEL)];
    let length = JPEG_XR_SINGLE_PIXEL.length;
    for (const piece of chain) {
      if (length % 2 !== 0) {
        pieces.push(Buffer.alloc(1));
        length += 1;
      }
      pieces.push(piece);
      length += piece.length;
    }
    const bytes = Buffer.concat(pieces);
    bytes.writeUInt32LE(chain.length === 0 ? 0 : JPEG_XR_SINGLE_PIXEL.length + (JPEG_XR_SINGLE_PIXEL.length % 2), nextOffsetAt);
    return bytes;
  }

  /** The offset the directory number `index` of a chain of `sizes`-long directories starts at, as `withChain` lays them out. */
  function offsetOf(index: number, sizes: readonly number[]): number {
    let at = JPEG_XR_SINGLE_PIXEL.length + (JPEG_XR_SINGLE_PIXEL.length % 2);
    for (let before = 0; before < index; before += 1) at += sizes[before] + (sizes[before] % 2);
    return at;
  }

  const EMPTY_DIRECTORY_BYTES = 6;
  const emptyChain = (length: number): Buffer[] => Array.from({ length }, (_unused, index) => directory([], index + 1 < length ? offsetOf(index + 1, Array(length).fill(EMPTY_DIRECTORY_BYTES)) : 0));

  it("is followed to its end, and the size is still the first image's", () => {
    expect(jpegXrSize(withChain(emptyChain(2)))).toEqual({
      width: 1,
      height: 1,
    });
  });

  it('is refused when a directory leads back to itself (the renderer never finishes reading it)', () => {
    const own = offsetOf(0, [EMPTY_DIRECTORY_BYTES]);
    expect(() => jpegXrSize(withChain([directory([], own)]))).toThrow(/directories loop/);
  });

  it("is refused when the sample's own directory is named again by the chain", () => {
    expect(() => jpegXrSize(withChain([directory([], sampleDirectory)]))).toThrow(/directories loop/);
  });

  it('is refused when two directories name each other', () => {
    const sizes = [EMPTY_DIRECTORY_BYTES, EMPTY_DIRECTORY_BYTES];
    expect(() => jpegXrSize(withChain([directory([], offsetOf(1, sizes)), directory([], offsetOf(0, sizes))]))).toThrow(/directories loop/);
  });

  const MAX_DIRECTORIES = 64;

  it(`reads a chain of ${MAX_DIRECTORIES} directories and refuses one of ${MAX_DIRECTORIES + 1}`, () => {
    // The sample's own directory is the first of the chain.
    expect(jpegXrSize(withChain(emptyChain(MAX_DIRECTORIES - 1)))).toEqual({
      width: 1,
      height: 1,
    });
    expect(() => jpegXrSize(withChain(emptyChain(MAX_DIRECTORIES)))).toThrow(/more than 64 directories/);
  });

  it('is refused when the next directory is at an odd offset or past the end of the file (the renderer stops with an error)', () => {
    const odd = withChain([directory([], 0)]);
    odd.writeUInt32LE(odd.readUInt32LE(nextOffsetAt) + 1, nextOffsetAt);
    expect(() => jpegXrSize(odd)).toThrow(ConversionFailedError);
    const past = withChain([directory([], 0)]);
    past.writeUInt32LE(past.length, nextOffsetAt);
    expect(() => jpegXrSize(past)).toThrow(ConversionFailedError);
  });

  it('is refused when a later directory holds a USHORT array of more than 65,535 values (a 16-bit counter that never reaches the count)', () => {
    const at = offsetOf(0, [EMPTY_DIRECTORY_BYTES + ENTRY_BYTES]);
    const looping = withChain([directory([entry(0x1000, TYPE_USHORT, 65_536, at + 20)], 0)]);
    expect(() => jpegXrSize(looping)).toThrow(/more than 65535 values/);
  });

  it.each([
    ['a USHORT array', TYPE_USHORT, 3],
    ['a ULONG array', TYPE_ULONG, 2],
    ['a rational array', TYPE_URATIONAL, 1],
  ])('is refused when %s of a later directory runs past the end of the file', (_label, type, count) => {
    const bytes = withChain([directory([entry(0x1000, type, count, 0)], 0)]);
    // The array starts two bytes before the end of the file, which no array of these counts fits in.
    bytes.writeUInt32LE(bytes.length - 2, offsetOf(0, [EMPTY_DIRECTORY_BYTES + ENTRY_BYTES]) + 2 + 8);
    expect(() => jpegXrSize(bytes)).toThrow(/array runs past the end/);
  });

  it('is refused when a later directory asks for a ULONG array of two billion values (an allocation of 8 GB)', () => {
    const bytes = withChain([directory([entry(0x1000, TYPE_ULONG, 2_000_000_000, 0)], 0)]);
    expect(() => jpegXrSize(bytes)).toThrow(/array runs past the end/);
  });

  it('reads a later directory whose arrays lie inside the file', () => {
    const at = offsetOf(0, [EMPTY_DIRECTORY_BYTES + ENTRY_BYTES]);
    const array = Buffer.alloc(8);
    const bytes = withChain([Buffer.concat([directory([entry(0x1000, TYPE_USHORT, 4, at + EMPTY_DIRECTORY_BYTES + ENTRY_BYTES)], 0), array])]);
    expect(jpegXrSize(bytes)).toEqual({ width: 1, height: 1 });
  });
});

describe('the pixels an XPS image costs', () => {
  it('is the width times the height of a JPEG, a PNG and a TIFF, read from the header', async () => {
    const picture = await rawImage(200, 100);
    expect(await xpsImagePixels(await picture.clone().jpeg().toBuffer())).toBe(20_000);
    expect(await xpsImagePixels(await picture.clone().png().toBuffer())).toBe(20_000);
    expect(await xpsImagePixels(await picture.clone().tiff().toBuffer())).toBe(20_000);
  });

  it('is the width times the height of a JPEG XR image', async () => {
    expect(await xpsImagePixels(JPEG_XR_WIDE_70000_BY_1)).toBe(70_000);
    expect(await xpsImagePixels(JPEG_XR_WINDOWED_37_BY_22)).toBe(37 * 22);
  });

  it('is 0 for a part that is no image, such as a colour profile', async () => {
    expect(await xpsImagePixels(Buffer.concat([Buffer.alloc(36), Buffer.from('acsp', 'latin1'), Buffer.alloc(100)]))).toBe(0);
  });

  it('is refused for a PNG that declares 60,000 x 60,000 pixels in a few dozen bytes, before any pixel is decoded', async () => {
    const bomb = pngDeclaring(60_000, 60_000);
    expect(bomb.length).toBeLessThan(100);
    await expect(xpsImagePixels(bomb)).rejects.toBeInstanceOf(InputPixelLimitError);
  });

  it('is refused for a JPEG XR file that declares 4 billion pixels, and a PNG at the input limit is read', async () => {
    const bomb = Buffer.from(JPEG_XR_WIDE_70000_BY_1);
    const stream = bomb.indexOf('WMPHOTO');
    bomb.writeUInt32BE(3_999_999_999, stream + 12);
    bomb.writeUInt32BE(0, stream + 16);
    await expect(xpsImagePixels(bomb)).rejects.toBeInstanceOf(InputPixelLimitError);
    expect(await xpsImagePixels(pngDeclaring(10_000, 10_000))).toBe(100_000_000);
    await expect(xpsImagePixels(pngDeclaring(10_000, 10_001))).rejects.toBeInstanceOf(InputPixelLimitError);
  });

  it('is refused for a part that starts like a JPEG and holds no header', async () => {
    const refusal = xpsImagePixels(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64)]));
    await expect(refusal).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(refusal).rejects.toThrow(/Invalid image: the header could not be decoded/);
  });
});
