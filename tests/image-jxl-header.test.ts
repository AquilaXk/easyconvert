import { describe, expect, it } from 'vitest';
import { declaredJxlSize } from '../src/lib/conversions/image-jxl-cli';
import { isJxl, JXL_CODESTREAM_SIGNATURE, JXL_CONTAINER_SIGNATURE, sniffFixedSignature } from '../src/lib/format-signatures';
import { assertNotSpoofedFile, FileExtensionSpoofError, isFormatCompatibleWithMagicBytes, sniffMimeTypeFromMagicBytes } from '../src/lib/registry';
import { jxlCodestream, jxlContainer, jxlSizeHeader } from './helpers/jxl-builders';

/**
 * JPEG XL (ISO/IEC 18181-1) is recognised by its two signatures, the bare codestream (FF 0A) and the ISOBMFF container (a
 * 12-byte `JXL ` box), and its size is read from the SizeHeader without decoding anything. The headers here are written bit by bit from the
 * layout of the specification (the SizeHeader of 18181-1 section 6.2 and the box layout of 18181-2 section 3); the real files of the
 * conformance set are read in image-jxl-decode.test.ts.
 */

const HEADER_ERROR = 'Invalid image: the JPEG XL header could not be decoded';
const JXL_CONTAINER_SIGNATURE_BYTES = Buffer.from(JXL_CONTAINER_SIGNATURE);

describe('the SizeHeader of a bare codestream', () => {
  it.each([
    ['a small picture (sides in multiples of 8)', { small: true, width: 64, height: 40 }, 64, 40],
    ['the largest small picture', { small: true, width: 256, height: 256 }, 256, 256],
    ['a picture that states both sides', { small: false, width: 1000, height: 7 }, 1000, 7],
    ['a one-pixel picture', { small: false, width: 1, height: 1 }, 1, 1],
    ['sides that need the 13-bit field', { small: false, width: 6000, height: 4000 }, 6000, 4000],
    ['sides that need the 18-bit field', { small: false, width: 70_000, height: 70_000 }, 70_000, 70_000],
    ['the largest side of the 9-bit field', { small: false, width: 512, height: 512 }, 512, 512],
    ['the first side of the 13-bit field', { small: false, width: 513, height: 513 }, 513, 513],
    ['the largest side of the 13-bit field', { small: false, width: 8192, height: 8192 }, 8192, 8192],
    ['the first side of the 18-bit field', { small: false, width: 8193, height: 8193 }, 8193, 8193],
    ['the largest side of the 18-bit field', { small: false, width: 262_144, height: 262_144 }, 262_144, 262_144],
    ['the first side of the 30-bit field', { small: false, width: 262_145, height: 262_145 }, 262_145, 262_145],
    ['sides that need the 30-bit field', { small: false, width: 600_000_000, height: 1000 }, 600_000_000, 1000],
  ])('reads %s', (_label, header, width, height) => {
    expect(declaredJxlSize(jxlCodestream(jxlSizeHeader(header)))).toEqual({ width, height });
  });

  it.each([
    ['1:1', 1, 720, 720],
    ['12:10', 2, 720, 864],
    ['4:3', 3, 720, 960],
    ['3:2', 4, 720, 1080],
    ['16:9', 5, 720, 1280],
    ['5:4', 6, 720, 900],
    ['2:1', 7, 720, 1440],
    ['16:9 of a side that does not divide', 5, 721, 1281],
  ])('derives the width of the %s ratio from the height', (_label, ratio, height, width) => {
    expect(declaredJxlSize(jxlCodestream(jxlSizeHeader({ small: false, ratio, height })))).toEqual({ width, height });
  });
});

describe('the SizeHeader of a small picture with an aspect ratio', () => {
  it.each([
    [1, 144, 144],
    [3, 144, 192],
    [5, 144, 256],
    [7, 128, 256],
  ])('derives the width of ratio %i from a height of %i pixels', (ratio, height, width) => {
    expect(declaredJxlSize(jxlCodestream(jxlSizeHeader({ small: true, ratio, height })))).toEqual({ width, height });
  });
});

describe('the container', () => {
  const header = jxlSizeHeader({ small: false, width: 300, height: 200 });

  it.each([
    ['a single codestream box', jxlContainer([{ type: 'jxlc', content: jxlCodestream(header) }])],
    ['boxes before the codestream', jxlContainer([{ type: 'Exif', content: Buffer.alloc(12) }, { type: 'jxlc', content: jxlCodestream(header) }])],
    ['partial codestream boxes, the header across two of them', jxlContainer(partialBoxes(jxlCodestream(header), 3))],
    ['a 64-bit box length', jxlContainer([{ type: 'jxlc', content: jxlCodestream(header), largeSize: true }])],
    ['a codestream box that runs to the end of the file', jxlContainer([{ type: 'jxlc', content: jxlCodestream(header), toEnd: true }])],
  ])('finds the size behind %s', (_label, file) => {
    expect(declaredJxlSize(file)).toEqual({ width: 300, height: 200 });
  });

  it.each([
    ['no box after the signature', jxlContainer([])],
    ['only boxes that hold no codestream', jxlContainer([{ type: 'Exif', content: Buffer.alloc(12) }])],
    ['a box shorter than its header', Buffer.concat([JXL_CONTAINER_SIGNATURE_BYTES, Buffer.from([0, 0, 0, 4, 0x6a, 0x78, 0x6c, 0x63])])],
    ['a 64-bit box length that is cut', Buffer.concat([JXL_CONTAINER_SIGNATURE_BYTES, Buffer.from([0, 0, 0, 1, 0x6a, 0x78, 0x6c, 0x63, 0, 0])])],
    ['a codestream box with no codestream signature', jxlContainer([{ type: 'jxlc', content: Buffer.alloc(16) }])],
  ])('refuses a container with %s', (_label, file) => {
    expect(() => declaredJxlSize(file)).toThrow(HEADER_ERROR);
  });
});

describe('bytes that are not a JPEG XL picture', () => {
  it.each([
    ['text', Buffer.from('not a picture, just text')],
    ['a PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['an empty file', Buffer.alloc(0)],
    ['the signature alone', Buffer.from([0xff, 0x0a])],
    ['a SizeHeader that stops in a field', Buffer.from([0xff, 0x0a, 0x00])],
  ])('refuses %s', (_label, file) => {
    expect(() => declaredJxlSize(file)).toThrow(HEADER_ERROR);
  });
});

/** The codestream cut into `parts` partial codestream boxes (`jxlp`: a 32-bit index, whose top bit marks the last one, then the bytes). */
function partialBoxes(codestream: Buffer, parts: number): { type: string; content: Buffer }[] {
  const size = Math.ceil(codestream.length / parts);
  return Array.from({ length: parts }, (_unused, index) => {
    const index32 = Buffer.alloc(4);
    index32.writeUInt32BE(index === parts - 1 ? (0x80000000 | index) >>> 0 : index, 0);
    return { type: 'jxlp', content: Buffer.concat([index32, codestream.subarray(index * size, (index + 1) * size)]) };
  });
}

describe('the signatures', () => {
  const codestream = jxlCodestream(jxlSizeHeader({ small: true, width: 16, height: 16 }));
  const container = jxlContainer([{ type: 'jxlc', content: codestream }]);

  it('are the bytes of the specification', () => {
    expect([...JXL_CODESTREAM_SIGNATURE]).toEqual([0xff, 0x0a]);
    expect([...JXL_CONTAINER_SIGNATURE]).toEqual([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
  });

  it.each([
    ['a bare codestream', codestream],
    ['a container', container],
  ])('sniff %s as image/jxl', (_label, bytes) => {
    expect(sniffMimeTypeFromMagicBytes(bytes)).toBe('image/jxl');
    expect(sniffFixedSignature(bytes)).toBe('image/jxl');
    expect(isJxl(bytes)).toBe(true);
  });

  it('are accepted under the .jxl name and under no other', () => {
    for (const bytes of [codestream, container]) {
      expect(isFormatCompatibleWithMagicBytes(bytes, 'jxl')).toBe(true);
      expect(isFormatCompatibleWithMagicBytes(bytes, '.JXL')).toBe(true);
      expect(() => assertNotSpoofedFile(bytes, 'jxl', 'photo.jxl')).not.toThrow();
      for (const other of ['png', 'jpg', 'webp', 'avif', 'heic', 'jp2', 'mp3', 'aac', 'pdf', 'txt']) {
        expect(isFormatCompatibleWithMagicBytes(bytes, other), other).toBe(false);
      }
      expect(() => assertNotSpoofedFile(bytes, 'png', 'photo.png')).toThrow(FileExtensionSpoofError);
    }
  });

  it('refuse the other pictures and unsigned bytes under the .jxl name', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const adts = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]);
    for (const bytes of [png, jpeg, adts, Buffer.from('plain text'), Buffer.from([0xff, 0x0b, 0, 0]), Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0b])]) {
      expect(isFormatCompatibleWithMagicBytes(bytes, 'jxl')).toBe(false);
    }
    expect(() => assertNotSpoofedFile(png, 'jxl', 'photo.jxl')).toThrow(FileExtensionSpoofError);
  });

  it('leave the audio and the ISO base media sniffers alone', () => {
    expect(sniffMimeTypeFromMagicBytes(adtsFrame())).toBe('audio/aac');
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    expect(sniffMimeTypeFromMagicBytes(ftyp)).toBe('video/mp4');
  });
});

function adtsFrame(): Buffer {
  return Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc, 0, 0, 0, 0, 0]);
}
