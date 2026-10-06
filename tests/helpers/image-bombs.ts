import { deflateSync } from 'node:zlib';

/**
 * Hand-assembled image containers that declare a huge canvas in a few dozen bytes. They follow the container
 * specs (PNG: ISO/IEC 15948, JPEG: ITU-T T.81, WebP: RIFF container, TIFF 6.0) and carry no real pixel data,
 * so a decoder that honours the header would have to allocate the whole declared canvas.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** 8-bit RGB PNG that declares `width` x `height` and holds one deflated scanline of zeros. */
export function bombPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const scanline = Buffer.alloc(1 + width * 3);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Baseline JPEG whose SOF0 declares `width` x `height`; the scan holds a few entropy bytes. */
export function bombJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17, 0); // segment length: 8 + 3 components x 3
  sof[2] = 8; // sample precision
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3; // components
  sof.set([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1], 8);
  const dqt = Buffer.concat([Buffer.from([0x00, 0x43, 0x00]), Buffer.alloc(64, 1)]);
  const dhtDc = Buffer.concat([Buffer.from([0x00, 0x14, 0x00]), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0])]);
  const sos = Buffer.from([0x00, 0x0c, 3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xdb]),
    dqt,
    Buffer.from([0xff, 0xc0]),
    sof,
    Buffer.from([0xff, 0xc4]),
    dhtDc,
    Buffer.from([0xff, 0xda]),
    sos,
    Buffer.alloc(16),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Lossy WebP in an extended (VP8X) container whose canvas and VP8 key frame both declare `width` x `height`. */
export function bombWebp(width: number, height: number): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const vp8Data = Buffer.alloc(30);
  // Key frame tag: bit 0 = 0 (key frame), version 0, show_frame 1, first partition size.
  vp8Data.writeUIntLE((1 << 4) | (10 << 5), 0, 3);
  vp8Data.set([0x9d, 0x01, 0x2a], 3);
  vp8Data.writeUInt16LE(width, 6);
  vp8Data.writeUInt16LE(height, 8);
  const chunk = (fourcc: string, data: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.write(fourcc, 0, 'ascii');
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const payload = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk('VP8X', vp8x), chunk('VP8 ', vp8Data)]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
}

/** Little-endian baseline TIFF (8-bit greyscale, uncompressed) declaring `width` x `height` with one tiny strip. */
export function bombTiff(width: number, height: number): Buffer {
  const entries: Array<[number, number, number]> = [
    [256, 4, width], // ImageWidth
    [257, 4, height], // ImageLength
    [258, 3, 8], // BitsPerSample
    [259, 3, 1], // Compression: none
    [262, 3, 1], // PhotometricInterpretation: BlackIsZero
    [273, 4, 0], // StripOffsets (patched below)
    [277, 3, 1], // SamplesPerPixel
    [278, 4, height], // RowsPerStrip
    [279, 4, 16], // StripByteCounts
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const stripOffset = 8 + ifdSize;
  const out = Buffer.alloc(stripOffset + 16);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, value], i) => {
    const at = 10 + i * 12;
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(1, at + 4);
    if (type === 3) out.writeUInt16LE(value, at + 8);
    else out.writeUInt32LE(tag === 273 ? stripOffset : value, at + 8);
  });
  return out;
}

/** 24-bit uncompressed BMP header declaring `width` x `height` followed by one row of pixel data. */
export function bombBmp(width: number, height: number): Buffer {
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  return Buffer.concat([header, Buffer.alloc(Math.min(width * 3, 256))]);
}

/** GIF89a whose logical screen and single frame both declare `width` x `height`, with a one-block LZW stream. */
export function bombGif(width: number, height: number): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    screen,
    descriptor,
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]),
  ]);
}

const PNG_IHDR_CRC_OFFSET = 29;

/** The same PNG with a wrong CRC on its IHDR chunk: libvips refuses the header, lenient PNG readers do not. */
export function withBrokenIhdrCrc(png: Buffer): Buffer {
  const broken = Buffer.from(png);
  broken[PNG_IHDR_CRC_OFFSET] ^= 0xff;
  return broken;
}
