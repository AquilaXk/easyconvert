import sharp from 'sharp';
import { ConversionFailedError } from '../types';
import { assertInputPixels } from './image-input-limits';

/**
 * WAP Wireless Bitmap (WBMP, Type 0) decoder following WAP-237-WAES Section 6:
 * multi-byte uintvar header (`TypeField = 0`, `FixHeaderField`), uintvar width/height,
 * and MSB-first 1-bit pixel rows (bit 1 = white, bit 0 = black).
 */

const WBMP_TYPE_BW_UNCOMPRESSED = 0;
const WBMP_EXT_HEADER_FLAG = 0x80;
const UINTVAR_CONTINUATION_MASK = 0x80;
const UINTVAR_VALUE_MASK = 0x7f;
const UINTVAR_MAX_OCTETS = 4;
const BITS_PER_BYTE = 8;
const WHITE_LUMA = 255;
const BLACK_LUMA = 0;

interface UintvarRead {
  value: number;
  nextOffset: number;
}

function readUintvar(input: Buffer, startOffset: number, fieldName: string): UintvarRead {
  let offset = startOffset;
  let value = 0;
  for (let octets = 0; octets < UINTVAR_MAX_OCTETS; octets += 1) {
    if (offset >= input.length) {
      throw new ConversionFailedError(`Invalid WBMP header: truncated ${fieldName}.`);
    }
    const byte = input[offset];
    offset += 1;
    value = value * 128 + (byte & UINTVAR_VALUE_MASK);
    if ((byte & UINTVAR_CONTINUATION_MASK) === 0) {
      return { value, nextOffset: offset };
    }
  }
  throw new ConversionFailedError(`Invalid WBMP header: ${fieldName} exceeds ${UINTVAR_MAX_OCTETS}-byte uintvar bound.`);
}

function expandMonoRows(input: Buffer, dataOffset: number, width: number, height: number, rowStride: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const srcRowOffset = dataOffset + y * rowStride;
    const dstRowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      const packed = input[srcRowOffset + (x >>> 3)];
      const bit = (packed >>> (BITS_PER_BYTE - 1 - (x & 7))) & 1;
      gray[dstRowOffset + x] = bit === 1 ? WHITE_LUMA : BLACK_LUMA;
    }
  }
  return gray;
}

/** Decodes a WBMP Type 0 bitmap into an 8-bit grayscale PNG buffer. */
export async function decodeWbmpToPng(input: Buffer): Promise<Buffer> {
  if (input.length < 4) {
    throw new ConversionFailedError('Invalid WBMP image: file is shorter than the 4-byte minimum header.');
  }

  const typeRead = readUintvar(input, 0, 'TypeField');
  if (typeRead.value !== WBMP_TYPE_BW_UNCOMPRESSED) {
    throw new ConversionFailedError(`Unsupported WBMP type ${typeRead.value}: only Type 0 monochrome WBMP is supported.`);
  }

  if (typeRead.nextOffset >= input.length) {
    throw new ConversionFailedError('Invalid WBMP header: missing FixHeaderField.');
  }
  const fixHeader = input[typeRead.nextOffset];
  let offset = typeRead.nextOffset + 1;
  if ((fixHeader & WBMP_EXT_HEADER_FLAG) !== 0) {
    throw new ConversionFailedError('Unsupported WBMP image: extended headers are not supported.');
  }

  const widthRead = readUintvar(input, offset, 'Width');
  const heightRead = readUintvar(input, widthRead.nextOffset, 'Height');
  const width = widthRead.value;
  const height = heightRead.value;
  offset = heightRead.nextOffset;

  if (width <= 0 || height <= 0) {
    throw new ConversionFailedError(`Invalid WBMP dimensions: ${width}x${height}.`);
  }

  assertInputPixels(width, height);

  const rowStride = Math.ceil(width / BITS_PER_BYTE);
  const expectedBytes = rowStride * height;
  if (input.length - offset < expectedBytes) {
    throw new ConversionFailedError(
      `Invalid WBMP image: expected ${expectedBytes} bytes of pixel data for ${width}x${height}, found ${input.length - offset}.`
    );
  }

  const pixels = expandMonoRows(input, offset, width, height, rowStride);
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
