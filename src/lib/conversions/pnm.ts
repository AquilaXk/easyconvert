import os from 'node:os';
import { OcrPreprocessError, OcrPreprocessFaultError } from '../types';

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
const MOST_SIGNIFICANT_BIT = 0x80;
const RGB_CHANNELS = 3;
/** The header is a few dozen bytes; a page of this many pixels per side is far beyond any scan. */
const PNM_MAX_SIDE_PX = 1_000_000;
const WORD_BYTES = 4;
const WORD_ALIGN_MASK = 3;
/** Bit 0 of each byte lane is masked off so `(w ^ (w << 1))` detects any byte not equal to `0x00` or `0xff` without cross-lane carries. */
const BITONAL_WORD_MASK = 0xfefefefe;
const SIGN_BIT_WORD_MASK = 0x80808080;
const SWAR_NIBBLE_PACK = 0x08040201;
const IS_LITTLE_ENDIAN = os.endianness() === 'LE';

function assertDimensions(width: number, height: number): void {
  const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
  if (!valid) throw new OcrPreprocessFaultError(`Cannot write a ${width}x${height} PNM image.`);
  if (width > PNM_MAX_SIDE_PX || height > PNM_MAX_SIDE_PX) {
    throw new OcrPreprocessError(`A ${width}x${height} page has a side over the ${PNM_MAX_SIDE_PX} pixels a page of OCR may have.`);
  }
}

function assertSampleCount(samples: number, expected: number, what: string): void {
  if (samples !== expected) {
    throw new OcrPreprocessFaultError(`Expected ${expected} ${what} samples for the PNM image, got ${samples}.`);
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
  const len = gray.length;
  let i = 0;
  if (len >= WORD_BYTES) {
    const alignSkip = (WORD_BYTES - (gray.byteOffset & WORD_ALIGN_MASK)) & WORD_ALIGN_MASK;
    for (; i < alignSkip; i++) {
      if (gray[i] !== 0 && gray[i] !== PNM_MAX_SAMPLE) return false;
    }
    const wordCount = (len - i) >>> 2;
    const words = new Uint32Array(gray.buffer, gray.byteOffset + i, wordCount);
    for (let w = 0; w < wordCount; w++) {
      const val = words[w];
      if (((val ^ (val << 1)) & BITONAL_WORD_MASK) !== 0) return false;
    }
    i += wordCount << 2;
  }
  for (; i < len; i++) {
    if (gray[i] !== 0 && gray[i] !== PNM_MAX_SAMPLE) return false;
  }
  return true;
}

function packPbmByteUnaligned(gray: Uint8Array, s: number): number {
  return (
    ((gray[s] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) |
    (((gray[s + 1] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) >>> 1) |
    (((gray[s + 2] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) >>> 2) |
    (((gray[s + 3] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) >>> 3) |
    (((gray[s + 4] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) >>> 4) |
    (((gray[s + 5] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) >>> 5) |
    (((gray[s + 6] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) >>> 6) |
    (((gray[s + 7] ^ MOST_SIGNIFICANT_BIT) & MOST_SIGNIFICANT_BIT) >>> 7)
  );
}

/** P4: a gray page packed to one bit per pixel; levels up to PBM_BLACK_MAX_LEVEL are black (bit 1). */
export function encodePbm(gray: Uint8Array, width: number, height: number): Buffer {
  assertDimensions(width, height);
  assertSampleCount(gray.length, width * height, 'gray');
  const rowBytes = Math.ceil(width / BITS_PER_BYTE);
  const packed = new Uint8Array(rowBytes * height);
  const alignDelta = (WORD_BYTES - (gray.byteOffset & WORD_ALIGN_MASK)) & WORD_ALIGN_MASK;
  const canUseWords = IS_LITTLE_ENDIAN && gray.length >= alignDelta + WORD_BYTES;
  const words = canUseWords
    ? new Uint32Array(gray.buffer, gray.byteOffset + alignDelta, (gray.length - alignDelta) >>> 2)
    : undefined;
  const wholeBytes = width >>> 3;
  const alignedPx = wholeBytes << 3;

  for (let y = 0; y < height; y++) {
    const source = y * width;
    let dst = y * rowBytes;
    if (words && ((gray.byteOffset + source) & WORD_ALIGN_MASK) === 0) {
      let wIdx = (source - alignDelta) >>> 2;
      for (let b = 0; b < wholeBytes; b++, wIdx += 2) {
        const hi = Math.imul((~words[wIdx] & SIGN_BIT_WORD_MASK) >>> 7, SWAR_NIBBLE_PACK) >>> 20;
        const lo = Math.imul((~words[wIdx + 1] & SIGN_BIT_WORD_MASK) >>> 7, SWAR_NIBBLE_PACK) >>> 24;
        packed[dst++] = (hi & 0xf0) | (lo & 0x0f);
      }
    } else {
      for (let x = 0; x < alignedPx; x += BITS_PER_BYTE) {
        packed[dst++] = packPbmByteUnaligned(gray, source + x);
      }
    }
    if (alignedPx < width) {
      let tail = 0;
      for (let bit = 0; alignedPx + bit < width; bit++) {
        if (gray[source + alignedPx + bit] <= PBM_BLACK_MAX_LEVEL) {
          tail |= MOST_SIGNIFICANT_BIT >> bit;
        }
      }
      packed[dst] = tail;
    }
  }
  return withHeader(`P4\n${width} ${height}\n`, packed);
}
