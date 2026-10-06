import { CorruptStreamError, DecompressionLimitError } from '../types';
import { InflateBudget, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';

/**
 * Bounded decoders for the stream filters a text-bearing PDF stream may chain (ISO 32000-1 section
 * 7.4): ASCIIHexDecode, ASCII85Decode and the PNG and TIFF predictors of FlateDecode. Each decoder
 * sizes its output before allocating it, so no input expands past the per-stream cap or the
 * document budget, and malformed data throws a CorruptStreamError.
 */

const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_FF = 12;
const CHAR_CR = 13;
const CHAR_NUL = 0;
const CHAR_SPACE = 32;
const CHAR_BANG = 33;
const CHAR_LOWER_U = 117;
const CHAR_LOWER_Z = 122;
const CHAR_TILDE = 126;
const CHAR_GREATER = 62;
const CHAR_DIGIT_0 = 48;
const CHAR_DIGIT_9 = 57;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_F = 70;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const HEX_LETTER_OFFSET = 10;

const ASCII85_BASE = 85;
const ASCII85_GROUP_CHARS = 5;
const ASCII85_GROUP_BYTES = 4;
const UINT32_LIMIT = 0x100000000;
const BITS_PER_BYTE = 8;
const NIBBLE_BITS = 4;

const PNG_FILTER_NONE = 0;
const PNG_FILTER_SUB = 1;
const PNG_FILTER_UP = 2;
const PNG_FILTER_AVERAGE = 3;
const PNG_FILTER_PAETH = 4;

/** Predictor values: 2 is TIFF predictor 2, 10 to 15 are PNG predictors whose rows carry their own filter byte. */
export const PREDICTOR_TIFF = 2;
export const PREDICTOR_PNG_MIN = 10;
export const PREDICTOR_PNG_MAX = 15;

export interface PredictorParams {
  predictor: number;
  colors: number;
  bitsPerComponent: number;
  columns: number;
}

function isWhiteCode(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_LF || code === CHAR_CR || code === CHAR_TAB || code === CHAR_FF || code === CHAR_NUL;
}

function limitFor(budget: InflateBudget): number {
  return Math.min(MAX_STREAM_INFLATE_BYTES, budget.remaining);
}

function assertWithinLimit(size: number, label: string, budget: InflateBudget): void {
  if (size > limitFor(budget)) {
    throw new DecompressionLimitError(`${label} decodes to more than the ${limitFor(budget)} bytes still allowed.`);
  }
}

function hexValue(code: number): number {
  if (code >= CHAR_DIGIT_0 && code <= CHAR_DIGIT_9) return code - CHAR_DIGIT_0;
  if (code >= CHAR_UPPER_A && code <= CHAR_UPPER_F) return code - CHAR_UPPER_A + HEX_LETTER_OFFSET;
  if (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F) return code - CHAR_LOWER_A + HEX_LETTER_OFFSET;
  return -1;
}

/** ASCIIHexDecode (section 7.4.2): hex digit pairs up to `>`, an odd last digit standing for a digit and a zero. */
export function decodeAsciiHex(data: Buffer, label: string, budget: InflateBudget): Buffer {
  const out = Buffer.alloc(Math.ceil(data.length / 2));
  let length = 0;
  let high = -1;
  for (let i = 0; i < data.length; i++) {
    const code = data[i];
    if (code === CHAR_GREATER) break;
    if (isWhiteCode(code)) continue;
    const value = hexValue(code);
    if (value < 0) throw new CorruptStreamError(`${label} has a byte that is not a hexadecimal digit.`);
    if (high < 0) {
      high = value;
    } else {
      out[length++] = (high << NIBBLE_BITS) | value;
      high = -1;
    }
  }
  if (high >= 0) out[length++] = high << NIBBLE_BITS;
  assertWithinLimit(length, label, budget);
  budget.charge(length, label);
  return out.subarray(0, length);
}

/** ASCII85Decode (section 7.4.3): five characters per four bytes, `z` for a zero group, `~>` ends the data. */
export function decodeAscii85(data: Buffer, label: string, budget: InflateBudget): Buffer {
  // First pass sizes the output, so a run of `z` cannot allocate more than the limit allows.
  let outputLength = 0;
  let pending = 0;
  let end = data.length;
  for (let i = 0; i < data.length; i++) {
    const code = data[i];
    if (isWhiteCode(code)) continue;
    if (code === CHAR_TILDE) {
      end = i;
      break;
    }
    if (code === CHAR_LOWER_Z && pending === 0) {
      outputLength += ASCII85_GROUP_BYTES;
    } else if (code >= CHAR_BANG && code <= CHAR_LOWER_U) {
      pending++;
      if (pending === ASCII85_GROUP_CHARS) {
        outputLength += ASCII85_GROUP_BYTES;
        pending = 0;
      }
    } else {
      throw new CorruptStreamError(`${label} has a byte that is not valid ASCII base-85 data.`);
    }
  }
  if (pending === 1) throw new CorruptStreamError(`${label} ends with a single ASCII base-85 character.`);
  if (pending > 1) outputLength += pending - 1;
  assertWithinLimit(outputLength, label, budget);

  const out = Buffer.alloc(outputLength);
  let written = 0;
  let value = 0;
  pending = 0;
  const flush = (count: number): void => {
    // A short final group is padded with the highest digit, then truncated (section 7.4.3).
    let padded = value;
    for (let p = count; p < ASCII85_GROUP_CHARS; p++) padded = padded * ASCII85_BASE + (ASCII85_BASE - 1);
    if (padded >= UINT32_LIMIT) throw new CorruptStreamError(`${label} has an ASCII base-85 group larger than 32 bits.`);
    for (let b = 0; b < count - 1 || (count === ASCII85_GROUP_CHARS && b < ASCII85_GROUP_BYTES); b++) {
      out[written++] = Math.floor(padded / 2 ** (BITS_PER_BYTE * (ASCII85_GROUP_BYTES - 1 - b))) & 0xff;
    }
  };
  for (let i = 0; i < end; i++) {
    const code = data[i];
    if (isWhiteCode(code)) continue;
    if (code === CHAR_LOWER_Z && pending === 0) {
      written += ASCII85_GROUP_BYTES;
      continue;
    }
    value = value * ASCII85_BASE + (code - CHAR_BANG);
    pending++;
    if (pending === ASCII85_GROUP_CHARS) {
      flush(ASCII85_GROUP_CHARS);
      value = 0;
      pending = 0;
    }
  }
  if (pending > 1) flush(pending);
  budget.charge(outputLength, label);
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/** Bytes per row of unpredicted data: columns of colors components of bitsPerComponent bits, byte aligned. */
export function predictorRowBytes(params: PredictorParams): number {
  return Math.ceil((params.colors * params.bitsPerComponent * params.columns) / BITS_PER_BYTE);
}

/**
 * Reverses a FlateDecode predictor (section 7.4.4.4). PNG predictors read the filter byte that leads
 * each row; TIFF predictor 2 adds the sample one pixel to the left, for 8 and 16 bits per component.
 * The output is never larger than the input.
 */
export function undoPredictor(data: Buffer, params: PredictorParams, label: string): Buffer {
  const rowBytes = predictorRowBytes(params);
  const bytesPerPixel = Math.max(1, Math.ceil((params.colors * params.bitsPerComponent) / BITS_PER_BYTE));

  if (params.predictor === PREDICTOR_TIFF) {
    const out = Buffer.from(data);
    const step = params.bitsPerComponent === 16 ? 2 : 1;
    for (let rowStart = 0; rowStart < out.length; rowStart += rowBytes) {
      const rowEnd = Math.min(rowStart + rowBytes, out.length);
      for (let i = rowStart + bytesPerPixel; i + step <= rowEnd; i += step) {
        if (step === 2) {
          const sum = out.readUInt16BE(i) + out.readUInt16BE(i - bytesPerPixel);
          out.writeUInt16BE(sum & 0xffff, i);
        } else {
          out[i] = (out[i] + out[i - bytesPerPixel]) & 0xff;
        }
      }
    }
    return out;
  }

  const stride = rowBytes + 1;
  const fullRows = Math.floor(data.length / stride);
  const tail = data.length - fullRows * stride - 1; // bytes of a last, incomplete row
  const out = Buffer.alloc(fullRows * rowBytes + Math.max(0, tail));
  const rows = fullRows + (tail > 0 ? 1 : 0);
  for (let r = 0; r < rows; r++) {
    const filter = data[r * stride];
    const width = r < fullRows ? rowBytes : tail;
    const inStart = r * stride + 1;
    const outStart = r * rowBytes;
    if (filter > PNG_FILTER_PAETH) throw new CorruptStreamError(`${label} has PNG predictor filter type ${filter}.`);
    for (let i = 0; i < width; i++) {
      const raw = data[inStart + i];
      const left = i >= bytesPerPixel ? out[outStart + i - bytesPerPixel] : 0;
      const up = r > 0 ? out[outStart - rowBytes + i] : 0;
      const upLeft = r > 0 && i >= bytesPerPixel ? out[outStart - rowBytes + i - bytesPerPixel] : 0;
      let predicted = 0;
      if (filter === PNG_FILTER_SUB) predicted = left;
      else if (filter === PNG_FILTER_UP) predicted = up;
      else if (filter === PNG_FILTER_AVERAGE) predicted = (left + up) >> 1;
      else if (filter === PNG_FILTER_PAETH) predicted = paeth(left, up, upLeft);
      out[outStart + i] = (raw + (filter === PNG_FILTER_NONE ? 0 : predicted)) & 0xff;
    }
  }
  return out;
}
