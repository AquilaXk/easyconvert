import zlib from 'node:zlib';
import { ConversionFailedError } from '../types';
import { copyYielding, CPU_POOL_MIN_BYTES, runCpuTask } from '../workers/cpu-pool';
import { crc32 } from './crc32';

/**
 * 16-bit RGB PNG writer (PNG Third Edition, W3C): per-row adaptive filtering chosen by the minimum sum of absolute
 * differences (section 12.8, "Filter selection"), samples written big-endian, one zlib stream of IDAT, and an optional
 * zlib-compressed iCCP profile.
 */

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const SAMPLES_PER_PIXEL = 3;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_PIXEL = SAMPLES_PER_PIXEL * BYTES_PER_SAMPLE;
const BIT_DEPTH = 16;
const COLOUR_TYPE_RGB = 2;
const IHDR_BYTES = 13;
const CHUNK_OVERHEAD_BYTES = 12;
const PNG_MAX_DIMENSION = 0x7fffffff;
/** The deflate level of the IDAT stream; the level that the image library's default encoder pass is compared at. */
export const PNG16_DEFAULT_LEVEL = 8;

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
const SIGNED_BYTE_SPLIT = 128;
const BYTE_RADIX = 256;
const BYTE_MASK = 0xff;

/** |v| of a byte read as a signed value: the weight each filtered byte adds to a row's cost. */
const SIGNED_MAGNITUDE = new Uint8Array(BYTE_RADIX);
for (let v = 0; v < BYTE_RADIX; v++) SIGNED_MAGNITUDE[v] = v < SIGNED_BYTE_SPLIT ? v : BYTE_RADIX - v;

function png16Failure(message: string): ConversionFailedError {
  return new ConversionFailedError(`16-bit PNG: ${message}`);
}

/** Checks the dimensions against the sample array before anything is allocated. */
export function assertPng16Dimensions(width: number, height: number, sampleCount: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) {
    throw png16Failure(`invalid dimensions ${width}x${height}`);
  }
  if (sampleCount !== width * height * SAMPLES_PER_PIXEL) {
    throw png16Failure(`sample count ${sampleCount} does not match ${width}x${height} RGB`);
  }
}

/**
 * Filters every row of the image and returns the scanlines (a filter-type byte followed by the filtered bytes of each
 * row). For each row all five filters are computed in one pass over the bytes and the one with the smallest sum of
 * absolute values (bytes read as signed) is kept; ties go to the lower filter number, as in libpng.
 */
export function filterPng16Scanlines(width: number, height: number, rgb16: Uint16Array): Uint8Array {
  assertPng16Dimensions(width, height, rgb16.length);
  const rowBytes = width * BYTES_PER_PIXEL;
  const scanlines = new Uint8Array(height * (rowBytes + 1));
  // Rows as big-endian bytes; the row above is kept for the Up, Average and Paeth predictors.
  let current = new Uint8Array(rowBytes);
  let previous = new Uint8Array(rowBytes);
  const sub = new Uint8Array(rowBytes);
  const up = new Uint8Array(rowBytes);
  const average = new Uint8Array(rowBytes);
  const paeth = new Uint8Array(rowBytes);
  const samplesPerRow = width * SAMPLES_PER_PIXEL;
  const magnitude = SIGNED_MAGNITUDE;

  for (let y = 0; y < height; y++) {
    const source = y * samplesPerRow;
    for (let i = 0, at = 0; i < samplesPerRow; i++, at += BYTES_PER_SAMPLE) {
      const sample = rgb16[source + i];
      current[at] = sample >> 8;
      current[at + 1] = sample & BYTE_MASK;
    }

    let costNone = 0;
    let costSub = 0;
    let costUp = 0;
    let costAverage = 0;
    let costPaeth = 0;
    // The first pixel has no left neighbour: a and c are zero.
    for (let i = 0; i < BYTES_PER_PIXEL && i < rowBytes; i++) {
      const x = current[i];
      const b = previous[i];
      costNone += magnitude[x];
      sub[i] = x;
      costSub += magnitude[x];
      const u = (x - b) & BYTE_MASK;
      up[i] = u;
      costUp += magnitude[u];
      const avg = (x - (b >> 1)) & BYTE_MASK;
      average[i] = avg;
      costAverage += magnitude[avg];
      // With a = c = 0 the Paeth predictor reduces to b.
      paeth[i] = u;
      costPaeth += magnitude[u];
    }
    for (let i = BYTES_PER_PIXEL; i < rowBytes; i++) {
      const x = current[i];
      const a = current[i - BYTES_PER_PIXEL];
      const b = previous[i];
      const c = previous[i - BYTES_PER_PIXEL];
      costNone += magnitude[x];
      const s = (x - a) & BYTE_MASK;
      sub[i] = s;
      costSub += magnitude[s];
      const u = (x - b) & BYTE_MASK;
      up[i] = u;
      costUp += magnitude[u];
      const avg = (x - ((a + b) >> 1)) & BYTE_MASK;
      average[i] = avg;
      costAverage += magnitude[avg];
      const p = a + b - c;
      const pa = p > a ? p - a : a - p;
      const pb = p > b ? p - b : b - p;
      const pc = p > c ? p - c : c - p;
      let predictor = c;
      if (pa <= pb && pa <= pc) predictor = a;
      else if (pb <= pc) predictor = b;
      const pt = (x - predictor) & BYTE_MASK;
      paeth[i] = pt;
      costPaeth += magnitude[pt];
    }

    let filter = FILTER_NONE;
    let best = costNone;
    if (costSub < best) {
      filter = FILTER_SUB;
      best = costSub;
    }
    if (costUp < best) {
      filter = FILTER_UP;
      best = costUp;
    }
    if (costAverage < best) {
      filter = FILTER_AVERAGE;
      best = costAverage;
    }
    if (costPaeth < best) {
      filter = FILTER_PAETH;
    }
    const out = y * (rowBytes + 1);
    scanlines[out] = filter;
    let chosen = current;
    if (filter === FILTER_SUB) chosen = sub;
    else if (filter === FILTER_UP) chosen = up;
    else if (filter === FILTER_AVERAGE) chosen = average;
    else if (filter === FILTER_PAETH) chosen = paeth;
    scanlines.set(chosen, out + 1);

    const swap = previous;
    previous = current;
    current = swap;
  }
  return scanlines;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(CHUNK_OVERHEAD_BYTES + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Assembles the PNG file around an already compressed IDAT payload. */
export function assemblePng16(width: number, height: number, idat: Uint8Array, iccProfile?: Uint8Array): Buffer {
  const header = Buffer.alloc(IHDR_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOUR_TYPE_RGB;
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  const parts: Uint8Array[] = [PNG_SIGNATURE, chunk('IHDR', header)];
  if (iccProfile && iccProfile.length > 0) {
    const name = Buffer.from('ICC Profile\0\0', 'latin1'); // name, null separator, compression method 0
    parts.push(chunk('iCCP', Buffer.concat([name, zlib.deflateSync(iccProfile)])));
  }
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}

/** Synchronous 16-bit RGB PNG encoder: filter, deflate and assemble on the calling thread. */
export function encode16BitPng(
  width: number,
  height: number,
  rgb16: Uint16Array,
  iccProfile?: Uint8Array,
  level: number = PNG16_DEFAULT_LEVEL
): Buffer {
  const scanlines = filterPng16Scanlines(width, height, rgb16);
  return assemblePng16(width, height, zlib.deflateSync(scanlines, { level }), iccProfile);
}

/**
 * Encodes without holding the event loop: images large enough to matter are filtered and deflated on a pool thread
 * (the samples are copied once and handed over, so the caller's array stays usable); small ones run inline.
 */
export async function encode16BitPngAsync(
  width: number,
  height: number,
  rgb16: Uint16Array,
  iccProfile?: Uint8Array,
  options: { level?: number; signal?: AbortSignal } = {}
): Promise<Buffer> {
  assertPng16Dimensions(width, height, rgb16.length);
  const level = options.level ?? PNG16_DEFAULT_LEVEL;
  if (rgb16.byteLength < CPU_POOL_MIN_BYTES) return encode16BitPng(width, height, rgb16, iccProfile, level);
  const copy = await copyYielding(rgb16);
  const bytes = await runCpuTask<Uint8Array>(
    'png16',
    { width, height, rgb16: copy, iccProfile, level },
    { signal: options.signal, transfer: [copy.buffer as ArrayBuffer] }
  );
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
