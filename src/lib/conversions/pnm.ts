import { OcrPreprocessError } from '../types';

/**
 * Netpbm portable anymap writer (http://netpbm.sourceforge.net/doc/pbm.html, pgm.html, ppm.html).
 * The recognizers read these without a codec: a header and the samples, so a page that is already
 * decoded is handed over as it is instead of being compressed to PNG and decoded again.
 *
 *   P4  bitonal, 1 bit per pixel, 1 is black, most significant bit first, rows padded to whole bytes
 *   P5  gray, one byte per pixel
 *   P6  RGB, three bytes per pixel
 */

/** Largest sample value of the 8-bit formats, written in the P5 and P6 headers. */
const PNM_MAX_SAMPLE = 255;
/** Pixels at or below this gray level are black in a bitonal page. */
const PBM_BLACK_MAX_LEVEL = 127;
const BITS_PER_BYTE = 8;
const BIT_INDEX_MASK = BITS_PER_BYTE - 1;
const BYTE_BIT_SHIFT = 3;
const MOST_SIGNIFICANT_BIT = 0x80;
const RGB_CHANNELS = 3;
/** The header is a few dozen bytes; a page of this many pixels per side is far beyond any scan. */
const PNM_MAX_SIDE_PX = 1_000_000;

function assertDimensions(width: number, height: number): void {
  const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
  if (!valid || width > PNM_MAX_SIDE_PX || height > PNM_MAX_SIDE_PX) {
    throw new OcrPreprocessError(`Cannot write a ${width}x${height} PNM image.`);
  }
}

function assertSampleCount(samples: number, expected: number, what: string): void {
  if (samples !== expected) {
    throw new OcrPreprocessError(`Expected ${expected} ${what} samples for the PNM image, got ${samples}.`);
  }
}

function withHeader(header: string, samples: Uint8Array): Buffer {
  const head = Buffer.from(header, 'ascii');
  const out = Buffer.allocUnsafe(head.length + samples.length);
  head.copy(out, 0);
  out.set(samples, head.length);
  return out;
}

/** P5: one byte per pixel, row-major, top row first. */
export function encodePgm(gray: Uint8Array, width: number, height: number): Buffer {
  assertDimensions(width, height);
  assertSampleCount(gray.length, width * height, 'gray');
  return withHeader(`P5\n${width} ${height}\n${PNM_MAX_SAMPLE}\n`, gray);
}

/** P6: three bytes (red, green, blue) per pixel, row-major, top row first. */
export function encodePpm(rgb: Uint8Array, width: number, height: number): Buffer {
  assertDimensions(width, height);
  assertSampleCount(rgb.length, width * height * RGB_CHANNELS, 'RGB');
  return withHeader(`P6\n${width} ${height}\n${PNM_MAX_SAMPLE}\n`, rgb);
}

/** Whether every pixel of an 8-bit gray page is pure black or pure white, so it fits in one bit. */
export function isBitonal(gray: Uint8Array): boolean {
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] !== 0 && gray[i] !== PNM_MAX_SAMPLE) return false;
  }
  return true;
}

/** P4: a gray page packed to one bit per pixel; levels up to PBM_BLACK_MAX_LEVEL are black (bit 1). */
export function encodePbm(gray: Uint8Array, width: number, height: number): Buffer {
  assertDimensions(width, height);
  assertSampleCount(gray.length, width * height, 'gray');
  const rowBytes = Math.ceil(width / BITS_PER_BYTE);
  const packed = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const source = y * width;
    const target = y * rowBytes;
    for (let x = 0; x < width; x++) {
      if (gray[source + x] <= PBM_BLACK_MAX_LEVEL) {
        packed[target + (x >> BYTE_BIT_SHIFT)] |= MOST_SIGNIFICANT_BIT >> (x & BIT_INDEX_MASK);
      }
    }
  }
  return withHeader(`P4\n${width} ${height}\n`, packed);
}
