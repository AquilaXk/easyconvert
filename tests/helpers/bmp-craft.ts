/**
 * Hand-written BMP and ICO builders for tests. They follow the Microsoft file format layout and share no code
 * with the decoder under test; the expected pixels come from ImageMagick decoding the same bytes.
 */

export interface CraftedBmp {
  /** DIB header size: 12 (core), 40 (info), 108 (V4) or 124 (V5). */
  header?: 12 | 40 | 108 | 124;
  width: number;
  /** Negative for a top-down bitmap. */
  height: number;
  bitCount: number;
  compression?: number;
  /** Colour table as [r, g, b] triples. */
  palette?: ReadonlyArray<readonly [number, number, number]>;
  /** `biClrUsed`; defaults to the palette length. */
  clrUsed?: number;
  /** Pixel data exactly as stored (rows padded to 4 bytes, or an RLE stream). */
  pixels: Uint8Array;
  /** Red, green, blue and alpha masks for BI_BITFIELDS (and V4/V5 headers). */
  masks?: readonly [number, number, number, number];
  /** Embedded ICC profile (V5 only). */
  icc?: Uint8Array;
  sizeImage?: number;
  /** Overrides, for hostile files. */
  overrideHeaderSize?: number;
  overridePixelOffset?: number;
}

const FILE_HEADER = 14;

export function craftBmp(spec: CraftedBmp): Buffer {
  const header = spec.header ?? 40;
  const palette = spec.palette ?? [];
  const entryBytes = header === 12 ? 3 : 4;
  const compression = spec.compression ?? 0;
  const separateMasks = header === 40 && (compression === 3 || compression === 6);
  const maskBytes = separateMasks ? (compression === 6 ? 16 : 12) : 0;
  const paletteBytes = palette.length * entryBytes;
  const profileBytes = spec.icc?.length ?? 0;
  const pixelOffset = spec.overridePixelOffset ?? FILE_HEADER + header + maskBytes + paletteBytes;
  const profileAt = FILE_HEADER + header + maskBytes + paletteBytes + spec.pixels.length;
  const total = FILE_HEADER + header + maskBytes + paletteBytes + spec.pixels.length + profileBytes;
  const out = Buffer.alloc(total);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(total, 2);
  out.writeUInt32LE(pixelOffset, 10);
  out.writeUInt32LE(spec.overrideHeaderSize ?? header, 14);
  if (header === 12) {
    out.writeUInt16LE(spec.width, 18);
    out.writeUInt16LE(Math.abs(spec.height), 20);
    out.writeUInt16LE(1, 22);
    out.writeUInt16LE(spec.bitCount, 24);
  } else {
    out.writeInt32LE(spec.width, 18);
    out.writeInt32LE(spec.height, 22);
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(spec.bitCount, 28);
    out.writeUInt32LE(compression, 30);
    out.writeUInt32LE(spec.sizeImage ?? spec.pixels.length, 34);
    out.writeUInt32LE(spec.clrUsed ?? palette.length, 46);
    const masks = spec.masks ?? [0, 0, 0, 0];
    if (header >= 108) {
      masks.forEach((m, i) => out.writeUInt32LE(m, FILE_HEADER + 40 + i * 4));
    }
    if (separateMasks) {
      masks.slice(0, compression === 6 ? 4 : 3).forEach((m, i) => out.writeUInt32LE(m, FILE_HEADER + 40 + i * 4));
    }
    if (header === 124 && spec.icc) {
      out.writeUInt32LE(0x4d424544, FILE_HEADER + 56); // 'MBED'
      out.writeUInt32LE(profileAt - FILE_HEADER, FILE_HEADER + 112);
      out.writeUInt32LE(spec.icc.length, FILE_HEADER + 116);
    } else if (header >= 108) {
      out.writeUInt32LE(0x73524742, FILE_HEADER + 56); // 'sRGB'
    }
  }
  let at = FILE_HEADER + header + maskBytes;
  for (const [r, g, b] of palette) {
    out[at] = b;
    out[at + 1] = g;
    out[at + 2] = r;
    at += entryBytes;
  }
  Buffer.from(spec.pixels).copy(out, FILE_HEADER + header + maskBytes + paletteBytes);
  if (spec.icc) Buffer.from(spec.icc).copy(out, profileAt);
  return out;
}

/** Stored row length in bytes for `bitCount` bits per pixel: rows are padded to 4 bytes. */
export function storedRowBytes(width: number, bitCount: number): number {
  return Math.floor((width * bitCount + 31) / 32) * 4;
}

/**
 * Packs rows of palette indices (top row first) at 1, 4 or 8 bits, bottom-up unless `topDown`, rows padded.
 */
export function packIndexed(rows: number[][], bitCount: 1 | 4 | 8, topDown = false): Uint8Array {
  const width = rows[0].length;
  const stride = storedRowBytes(width, bitCount);
  const out = new Uint8Array(stride * rows.length);
  rows.forEach((row, y) => {
    const stored = topDown ? y : rows.length - 1 - y;
    row.forEach((index, x) => {
      const bit = x * bitCount;
      out[stored * stride + (bit >> 3)] |= index << (8 - bitCount - (bit & 7));
    });
  });
  return out;
}

/** ICO/CUR file from images that are either PNG files or headerless DIBs. */
export function craftIco(images: ReadonlyArray<{ width: number; height: number; bitCount: number; data: Uint8Array }>, type = 1): Buffer {
  const directory = 6 + images.length * 16;
  let offset = directory;
  const total = directory + images.reduce((sum, i) => sum + i.data.length, 0);
  const out = Buffer.alloc(total);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(type, 2);
  out.writeUInt16LE(images.length, 4);
  images.forEach((image, i) => {
    const at = 6 + i * 16;
    out[at] = image.width >= 256 ? 0 : image.width;
    out[at + 1] = image.height >= 256 ? 0 : image.height;
    out.writeUInt16LE(1, at + 4);
    out.writeUInt16LE(image.bitCount, at + 6);
    out.writeUInt32LE(image.data.length, at + 8);
    out.writeUInt32LE(offset, at + 12);
    Buffer.from(image.data).copy(out, offset);
    offset += image.data.length;
  });
  return out;
}

/** The DIB of a BMP file: everything after the 14-byte file header, with the height doubled for the mask. */
export function dibOfBmp(bmp: Buffer, doubledHeight: boolean, mask?: Uint8Array): Buffer {
  const dib = Buffer.from(bmp.subarray(FILE_HEADER));
  if (doubledHeight) dib.writeInt32LE(dib.readInt32LE(8) * 2, 8);
  return mask ? Buffer.concat([dib, Buffer.from(mask)]) : dib;
}
