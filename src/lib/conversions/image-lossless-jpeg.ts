import { InvalidRawSensorError } from '../types';
import { RAW_SENSOR_PIXEL_BUDGET, assertInputPixels, assertPixelBudget } from './image-input-limits';

const MAX_HUFFMAN_CODES = 65536;
const MAX_LOSSLESS_SCAN_ZERO_PAD_BYTES = 4;

/** Refuses a lossless JPEG frame over the input limit, the RAW sensor budget, or the strip or tile that holds it. */
function assertLosslessFrameFits(width: number, height: number, expected?: { width: number; height: number }): void {
  assertInputPixels(width, height);
  assertPixelBudget(width, height, RAW_SENSOR_PIXEL_BUDGET);
  if (expected && (width > expected.width || height > expected.height)) {
    throw new InvalidRawSensorError(
      `Lossless JPEG frame of ${width}x${height} pixels is larger than the ${expected.width}x${expected.height} strip it is stored in.`
    );
  }
}

export function buildLosslessHuffmanLut(huffmanCounts: number[], huffmanSymbols: number[]): Int32Array {
  if (huffmanCounts.length !== 16) {
    throw new InvalidRawSensorError('Invalid Lossless JPEG DHT: expected 16 code length counts.');
  }
  const huffLut = new Int32Array(MAX_HUFFMAN_CODES).fill(-1);
  let symbolIdx = 0;
  let currentCode = 0;
  let kraftUsed = 0;

  for (let len = 1; len <= 16; len++) {
    const count = huffmanCounts[len - 1] || 0;
    const shift = 16 - len;
    const span = 1 << shift;
    kraftUsed += count * span;
    if (kraftUsed > MAX_HUFFMAN_CODES || symbolIdx + count > huffmanSymbols.length) {
      throw new InvalidRawSensorError('Invalid Lossless JPEG Huffman table: exceeds Kraft inequality or symbol list.');
    }
    for (let c = 0; c < count; c++) {
      const sym = huffmanSymbols[symbolIdx++] ?? 0;
      if (sym < 0 || sym > 16) {
        throw new InvalidRawSensorError(`Invalid Lossless JPEG Huffman category ${sym} (must be 0..16).`);
      }
      const entry = (len << 8) | sym;
      const baseIdx = (currentCode << shift) & 0xffff;
      huffLut.fill(entry, baseIdx, baseIdx + span);
      currentCode++;
    }
    currentCode <<= 1;
  }
  return huffLut;
}

interface ParsedLosslessHeader {
  width: number;
  height: number;
  bpp: number;
  predictor: number;
  pointTransform: number;
  scanStart: number;
  huffmanCounts: number[];
  huffmanSymbols: number[];
}

function parseLosslessJpegMarkers(buf: Buffer): ParsedLosslessHeader | null {
  let pos = 2;
  let width = 0;
  let height = 0;
  let bpp = 16;
  let predictor = 1;
  let pointTransform = 0;
  let scanStart = -1;
  let hasSof3 = false;
  let huffmanCounts: number[] = [];
  let huffmanSymbols: number[] = [];

  while (pos < buf.length - 1) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    if (marker === 0xff || marker === 0x00) {
      pos++;
      continue;
    }
    if (marker === 0xd8) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9) break;

    if (pos + 4 > buf.length) {
      throw new InvalidRawSensorError('Truncated Lossless JPEG marker length.');
    }
    const segLen = buf.readUInt16BE(pos + 2);
    if (segLen < 2 || pos + 2 + segLen > buf.length) {
      throw new InvalidRawSensorError(`Invalid Lossless JPEG marker 0x${marker.toString(16)} segment length ${segLen}.`);
    }
    const segDataStart = pos + 4;

    if (marker === 0xc3) {
      if (segLen < 8) {
        throw new InvalidRawSensorError('Truncated Lossless JPEG SOF3 segment.');
      }
      bpp = buf[segDataStart];
      if (bpp < 2 || bpp > 16) {
        throw new InvalidRawSensorError(`Unsupported Lossless JPEG bit depth ${bpp} (expected 2..16).`);
      }
      height = buf.readUInt16BE(segDataStart + 1);
      width = buf.readUInt16BE(segDataStart + 3);
      hasSof3 = true;
    } else if (marker === 0xc4) {
      if (segLen < 19) {
        throw new InvalidRawSensorError('Truncated Lossless JPEG DHT segment.');
      }
      const dhtPos = segDataStart + 1;
      const counts = Array.from(buf.subarray(dhtPos, dhtPos + 16));
      const totalSymbols = counts.reduce((a, b) => a + b, 0);
      if (segLen < 19 + totalSymbols) {
        throw new InvalidRawSensorError('Truncated Lossless JPEG DHT symbol table.');
      }
      const symbols = Array.from(buf.subarray(dhtPos + 16, dhtPos + 16 + totalSymbols));
      for (const sym of symbols) {
        if (sym > 16) {
          throw new InvalidRawSensorError(`Invalid Lossless JPEG DHT symbol category ${sym} (must be <= 16).`);
        }
      }
      huffmanCounts = counts;
      huffmanSymbols = symbols;
    } else if (marker === 0xda) {
      const ns = buf[segDataStart];
      if (ns < 1 || segLen < 6 + ns * 2) {
        throw new InvalidRawSensorError('Invalid Lossless JPEG SOS segment.');
      }
      const predPos = segDataStart + 1 + ns * 2;
      predictor = buf[predPos];
      pointTransform = buf[predPos + 2] & 0x0f;
      scanStart = pos + 2 + segLen;
      break;
    }
    pos += 2 + segLen;
  }

  if (!hasSof3 || width <= 0 || height <= 0 || scanStart < 0 || scanStart > buf.length) {
    return null;
  }
  if (pointTransform < 0 || pointTransform >= bpp) {
    throw new InvalidRawSensorError(`Invalid Lossless JPEG SOS pointTransform ${pointTransform} for ${bpp}-bit frame.`);
  }
  if (huffmanCounts.length !== 16) {
    throw new InvalidRawSensorError('Missing Lossless JPEG Huffman table (DHT).');
  }
  return { width, height, bpp, predictor, pointTransform, scanStart, huffmanCounts, huffmanSymbols };
}

function predictLosslessPixel(
  outputData: Uint16Array,
  x: number,
  y: number,
  width: number,
  predictor: number,
  initialPredictor: number
): number {
  if (x === 0 && y === 0) return initialPredictor;
  if (y === 0) return outputData[x - 1];
  if (x === 0) return outputData[(y - 1) * width];

  const a = outputData[y * width + (x - 1)];
  const b = outputData[(y - 1) * width + x];
  const c = outputData[(y - 1) * width + (x - 1)];
  if (predictor === 1) return a;
  if (predictor === 2) return b;
  if (predictor === 3) return c;
  if (predictor === 4) return a + b - c;
  if (predictor === 5) return a + ((b - c) >> 1);
  if (predictor === 6) return b + ((a - c) >> 1);
  if (predictor === 7) return (a + b) >> 1;
  return a;
}

/**
 * Decodes a single-component lossless JPEG (ITU-T T.81 SOF3) sensor strip. The frame header is untrusted: its
 * size is checked against the input limit and the RAW sensor budget, and, when the container says how large the
 * strip or tile is (`expected`), against that size, before any sample is allocated.
 */
export function decodeLosslessJpegStrip(
  strip: Buffer | Uint8Array,
  expected?: { width: number; height: number }
): { width: number; height: number; data: Uint16Array; bpp: number } | null {
  if (strip.length < 16) return null;
  const buf = Buffer.isBuffer(strip) ? strip : Buffer.from(strip.buffer, strip.byteOffset, strip.byteLength);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  const header = parseLosslessJpegMarkers(buf);
  if (!header) return null;

  const { width, height, bpp, predictor, pointTransform, scanStart, huffmanCounts, huffmanSymbols } = header;
  assertLosslessFrameFits(width, height, expected);

  const huffLut = buildLosslessHuffmanLut(huffmanCounts, huffmanSymbols);
  let bitBuf = 0;
  let bitCnt = 0;
  let bytePtr = scanStart;
  let scanEof = false;
  let zeroPadBytes = 0;
  const bufLen = buf.length;

  const ensureBits = (): void => {
    bitBuf &= (1 << bitCnt) - 1;
    while (bitCnt <= 16) {
      let b = 0;
      if (!scanEof && bytePtr < bufLen) {
        b = buf[bytePtr++];
        if (b === 0xff) {
          if (bytePtr < bufLen && buf[bytePtr] === 0x00) {
            bytePtr++;
          } else {
            scanEof = true;
            b = 0;
            zeroPadBytes++;
          }
        }
      } else {
        scanEof = true;
        zeroPadBytes++;
      }
      if (zeroPadBytes > MAX_LOSSLESS_SCAN_ZERO_PAD_BYTES) {
        throw new InvalidRawSensorError('Truncated Lossless JPEG entropy scan stream.');
      }
      bitBuf = (bitBuf << 8) | b;
      bitCnt += 8;
    }
  };

  const outputData = new Uint16Array(width * height);
  const maxVal = (1 << bpp) - 1;
  const initialPredictor = 1 << (bpp - 1 - pointTransform);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitCnt < 16) ensureBits();
      const entry = huffLut[(bitBuf >>> (bitCnt - 16)) & 0xffff];
      let cat = 0;
      if (entry >= 0) {
        bitCnt -= entry >>> 8;
        cat = entry & 0xff;
      } else {
        bitCnt -= 1;
      }

      let diff = 0;
      if (cat === 16) {
        diff = 32768;
      } else if (cat > 0) {
        if (bitCnt < cat) ensureBits();
        const rawBits = (bitBuf >>> (bitCnt - cat)) & ((1 << cat) - 1);
        bitCnt -= cat;
        diff = rawBits < (1 << (cat - 1)) ? rawBits - ((1 << cat) - 1) : rawBits;
      }

      const predVal = predictLosslessPixel(outputData, x, y, width, predictor, initialPredictor);
      outputData[y * width + x] = (predVal + diff) & maxVal;
    }
  }

  return { width, height, data: outputData, bpp };
}

function ifdNumericItemSize(tagType: number): number {
  if (tagType === 3) return 2;
  if (tagType === 1) return 1;
  return 4;
}

export function readIfdNumberArray(
  buffer: Buffer,
  isLE: boolean,
  tagType: number,
  tagCount: number,
  offsetVal: number,
  maxCount: number
): number[] {
  if (tagCount <= 0) return [];
  if (!Number.isInteger(tagCount) || tagCount > maxCount) {
    throw new InvalidRawSensorError(`TIFF IFD numeric array count ${tagCount} exceeds maximum ${maxCount}.`);
  }
  const itemSize = ifdNumericItemSize(tagType);
  const totalBytes = tagCount * itemSize;
  let dataOffset = offsetVal;
  if (totalBytes > 4) {
    dataOffset = isLE ? buffer.readUInt32LE(offsetVal) : buffer.readUInt32BE(offsetVal);
  }
  if (dataOffset < 0 || dataOffset + totalBytes > buffer.length) {
    throw new InvalidRawSensorError(`TIFF IFD numeric array (${tagCount} entries) exceeds buffer bounds.`);
  }
  const arr = new Array<number>(tagCount);
  for (let idx = 0; idx < tagCount; idx++) {
    const itemPos = dataOffset + idx * itemSize;
    if (tagType === 3) arr[idx] = isLE ? buffer.readUInt16LE(itemPos) : buffer.readUInt16BE(itemPos);
    else if (tagType === 1) arr[idx] = buffer.readUInt8(itemPos);
    else arr[idx] = isLE ? buffer.readUInt32LE(itemPos) : buffer.readUInt32BE(itemPos);
  }
  return arr;
}

export function readIfdRationalArray(
  buffer: Buffer,
  isLE: boolean,
  tagType: number,
  tagCount: number,
  offsetVal: number,
  maxCount: number
): number[] {
  if (tagCount <= 0) return [];
  if (!Number.isInteger(tagCount) || tagCount > maxCount) {
    throw new InvalidRawSensorError(`TIFF IFD rational array count ${tagCount} exceeds maximum ${maxCount}.`);
  }
  const itemSize = 8;
  const totalBytes = tagCount * itemSize;
  const dataOffset = isLE ? buffer.readUInt32LE(offsetVal) : buffer.readUInt32BE(offsetVal);
  if (dataOffset < 0 || dataOffset + totalBytes > buffer.length) {
    throw new InvalidRawSensorError(`TIFF IFD rational array (${tagCount} entries) exceeds buffer bounds.`);
  }
  const arr = new Array<number>(tagCount);
  for (let idx = 0; idx < tagCount; idx++) {
    const itemPos = dataOffset + idx * itemSize;
    let num: number;
    let den: number;
    if (tagType === 10) {
      num = isLE ? buffer.readInt32LE(itemPos) : buffer.readInt32BE(itemPos);
      den = isLE ? buffer.readInt32LE(itemPos + 4) : buffer.readInt32BE(itemPos + 4);
    } else {
      num = isLE ? buffer.readUInt32LE(itemPos) : buffer.readUInt32BE(itemPos);
      den = isLE ? buffer.readUInt32LE(itemPos + 4) : buffer.readUInt32BE(itemPos + 4);
    }
    arr[idx] = den !== 0 ? num / den : num;
  }
  return arr;
}
