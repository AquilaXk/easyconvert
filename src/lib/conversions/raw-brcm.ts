/**
 * Raspberry Pi camera RAW frames ("JPEG + BRCM" files).
 *
 * The camera stack appends the sensor frame to its JPEG preview: a 32768-byte "BRCM" header block
 * followed by the Bayer dump. Layout of the header fields this decoder reads (offsets from the
 * start of the "BRCM" magic, little-endian):
 *
 *   0x008  u32  length of the rest of the block (32764)
 *   0x010  sensor name, NUL-terminated ASCII ("ov5647 version 0.1")
 *   0x0A0  u32  row stride of the Bayer dump in bytes
 *   0x0B0  mode name ("2592x1944Slow")
 *   0x0D0  u16  frame width, 0x0D2 u16 frame height
 *   0x0F4  u8   Bayer order (0 RGGB, 1 GBRG, 2 BGGR, 3 GRBG)
 *   0x10E  u16  frame width, 0x110 u16 frame height (second copy of the geometry)
 *
 * The dump is MIPI RAW10: every 5 bytes hold 4 pixels (four high bytes, then one byte with the
 * four 2-bit remainders, pixel 0 in the lowest bits). Rows are padded to the stride and the frame is
 * padded with extra rows to a multiple of 16.
 *
 * Colour handling: black level per sensor, grey-world white balance, Malvar-He-Cutler demosaic,
 * a generic CMOS colour-filter-array saturation matrix (no per-sensor characterisation exists in
 * the file) and the sRGB transfer curve. The output is 16-bit RGB.
 */
import { RawDecodeError } from '../types';
import { applyMatrixAndSrgbEncode, clamp16, exposureScale, MAX_SAMPLE_16, RGB_CHANNELS, type Matrix3x3 } from './raw-srgb';

export type BayerOrder = 'RGGB' | 'GBRG' | 'BGGR' | 'GRBG';

const BRCM_MAGIC = Buffer.from('BRCM', 'latin1');
export const BRCM_HEADER_BYTES = 32768;
const OFFSET_LENGTH_FIELD = 0x08;
const OFFSET_SENSOR_NAME = 0x10;
const SENSOR_NAME_MAX_BYTES = 64;
const OFFSET_STRIDE = 0xa0;
const OFFSET_WIDTH = 0xd0;
const OFFSET_HEIGHT = 0xd2;
const OFFSET_BAYER_ORDER = 0xf4;
const OFFSET_WIDTH_COPY = 0x10e;
const OFFSET_HEIGHT_COPY = 0x110;
const HEADER_FIELDS_END = 0x112;
const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX = 0x7e;

const BAYER_ORDERS: readonly BayerOrder[] = ['RGGB', 'GBRG', 'BGGR', 'GRBG'];

const BITS_PER_PIXEL = 10;
const BITS_PER_BYTE = 8;
const PIXELS_PER_GROUP = 4;
const BYTES_PER_GROUP = 5;
const LOW_BITS_PER_PIXEL = 2;
const LOW_BITS_MASK = 0x3;
const SENSOR_MAX_VALUE = (1 << BITS_PER_PIXEL) - 1;
const STRIDE_ALIGNMENT_BYTES = 32;
const MIN_DIMENSION = 4;

interface SensorCalibration {
  /** Black level in 10-bit counts: the sensor's pedestal in the camera stack's tuning data (1024 and 4096 on its 16-bit scale). */
  blackLevel: number;
  /** Full pixel array of the sensor; a frame cannot be larger. */
  maxWidth: number;
  maxHeight: number;
}

const SENSORS: ReadonlyMap<string, SensorCalibration> = new Map([
  ['ov5647', { blackLevel: 16, maxWidth: 2592, maxHeight: 1944 }],
  ['imx219', { blackLevel: 64, maxWidth: 3280, maxHeight: 2464 }],
]);

function sensorOf(name: string): SensorCalibration | undefined {
  return SENSORS.get(name.split(' ')[0]);
}

/** Share of the white range below which / above which a 2x2 cell is ignored by the white balance estimate. */
const WB_LOW_FRACTION = 0.05;
const WB_HIGH_FRACTION = 0.9;
const WB_MIN_GAIN = 0.25;
const WB_MAX_GAIN = 8;
/**
 * Sensor-to-sRGB matrix applied after white balance: the generic saturation matrix of small-pixel CMOS
 * colour-filter arrays (rows sum to one, so neutral stays neutral). The frame carries no sensor
 * colour characterisation, so this is an approximation, not a calibrated profile.
 */
const CFA_SATURATION_MATRIX: Matrix3x3 = [1.5, -0.35, -0.15, -0.25, 1.45, -0.2, -0.1, -0.4, 1.5];

export interface BrcmFrame {
  sensor: string;
  width: number;
  height: number;
  stride: number;
  bayer: BayerOrder;
  /** Offset of the first Bayer row in the file. */
  dataOffset: number;
}

export interface DecodedRgb16 {
  width: number;
  height: number;
  /** Interleaved gamma-encoded sRGB, 16 bits per sample. */
  rgb16: Uint16Array;
}

function fail(detail: string): RawDecodeError {
  return new RawDecodeError(`Raspberry Pi RAW frame is malformed: ${detail}`);
}

/** A layout this decoder does not handle (as opposed to a damaged file): the preview fallback applies. */
function unsupported(detail: string): RawDecodeError {
  return new RawDecodeError(`Raspberry Pi RAW frame is not supported: ${detail}`, true);
}

/**
 * Offset of the trailing "BRCM" block, or -1 when the file is not a Pi frame. The block is the last
 * thing in the file, so candidates are tried from the end. A candidate is recognised by its magic
 * followed by the block's own length field (header size minus the magic), which keeps a stray "BRCM"
 * inside some other camera file from being taken for a Pi frame.
 */
export function findBrcmTrailer(file: Buffer): number {
  let candidate = file.lastIndexOf(BRCM_MAGIC);
  while (candidate >= 0) {
    if (candidate + OFFSET_LENGTH_FIELD + 4 <= file.length && file.readUInt32LE(candidate + OFFSET_LENGTH_FIELD) === BRCM_HEADER_BYTES - BRCM_MAGIC.length) {
      return candidate;
    }
    if (candidate === 0) break;
    candidate = file.lastIndexOf(BRCM_MAGIC, candidate - 1);
  }
  return -1;
}

function readSensorName(file: Buffer, trailer: number): string {
  const start = trailer + OFFSET_SENSOR_NAME;
  let end = start;
  while (end < start + SENSOR_NAME_MAX_BYTES && file[end] !== 0) {
    if (file[end] < PRINTABLE_ASCII_MIN || file[end] > PRINTABLE_ASCII_MAX) throw fail('the sensor name is not text');
    end += 1;
  }
  if (end === start || end === start + SENSOR_NAME_MAX_BYTES) throw fail('the sensor name is missing or unterminated');
  return file.toString('latin1', start, end);
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** Parses and validates the header of the trailer at `trailer`. */
export function parseBrcmHeader(file: Buffer, trailer: number): BrcmFrame {
  if (trailer < 0 || trailer + BRCM_HEADER_BYTES > file.length || trailer + HEADER_FIELDS_END > file.length) {
    throw fail('the header block is cut short');
  }
  const sensor = readSensorName(file, trailer);
  const calibration = sensorOf(sensor);
  if (calibration === undefined) throw unsupported(`no calibration is known for the "${sensor}" sensor`);

  const width = file.readUInt16LE(trailer + OFFSET_WIDTH);
  const height = file.readUInt16LE(trailer + OFFSET_HEIGHT);
  if (width !== file.readUInt16LE(trailer + OFFSET_WIDTH_COPY) || height !== file.readUInt16LE(trailer + OFFSET_HEIGHT_COPY)) {
    throw fail('the two copies of the frame size disagree');
  }
  if (width < MIN_DIMENSION || height < MIN_DIMENSION || width % PIXELS_PER_GROUP !== 0 || height % 2 !== 0) {
    throw fail(`unsupported frame size ${width}x${height}`);
  }
  if (width > calibration.maxWidth || height > calibration.maxHeight) {
    throw fail(`the ${width}x${height} frame is larger than the ${calibration.maxWidth}x${calibration.maxHeight} ${sensor.split(' ')[0]} sensor`);
  }

  const rowBytes = (width / PIXELS_PER_GROUP) * BYTES_PER_GROUP;
  const stride = file.readUInt32LE(trailer + OFFSET_STRIDE);
  if (stride !== alignUp(rowBytes, STRIDE_ALIGNMENT_BYTES)) {
    throw unsupported(`the row stride ${stride} does not match packed 10-bit rows of ${width} pixels`);
  }
  const order = file[trailer + OFFSET_BAYER_ORDER];
  if (order >= BAYER_ORDERS.length) throw fail(`unknown Bayer order ${order}`);

  const dataOffset = trailer + BRCM_HEADER_BYTES;
  if (dataOffset + stride * height > file.length) {
    throw fail(`the sensor data is truncated: ${file.length - dataOffset} bytes present, ${stride * height} required`);
  }
  return { sensor, width, height, stride, bayer: BAYER_ORDERS[order], dataOffset };
}

/** Unpacks the MIPI RAW10 rows into one 16-bit value (0..1023) per pixel. */
export function unpackRaw10(file: Buffer, frame: BrcmFrame): Uint16Array {
  const { width, height, stride, dataOffset } = frame;
  const pixels = new Uint16Array(width * height);
  for (let row = 0; row < height; row += 1) {
    let source = dataOffset + row * stride;
    let target = row * width;
    for (let group = 0; group < width / PIXELS_PER_GROUP; group += 1) {
      const low = file[source + PIXELS_PER_GROUP];
      for (let k = 0; k < PIXELS_PER_GROUP; k += 1) {
        pixels[target + k] = (file[source + k] << LOW_BITS_PER_PIXEL) | ((low >> (LOW_BITS_PER_PIXEL * k)) & LOW_BITS_MASK);
      }
      source += BYTES_PER_GROUP;
      target += PIXELS_PER_GROUP;
    }
  }
  return pixels;
}

/** Channel (0 R, 1 G, 2 B) of the colour-filter cell at (x, y). */
function channelAt(bayer: BayerOrder, x: number, y: number): number {
  const letter = bayer[(y & 1) * 2 + (x & 1)];
  if (letter === 'R') return 0;
  if (letter === 'G') return 1;
  return 2;
}

/**
 * Grey-world gains on 2x2 cells whose samples are neither near black nor near saturation.
 * Returns [R, G, B] gains normalised to green.
 */
function estimateWhiteBalance(black: Float32Array, whiteRange: number, width: number, height: number, bayer: BayerOrder): [number, number, number] {
  const low = WB_LOW_FRACTION * whiteRange;
  const high = WB_HIGH_FRACTION * whiteRange;
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  for (let y = 0; y + 1 < height; y += 2) {
    for (let x = 0; x + 1 < width; x += 2) {
      const cell = [black[y * width + x], black[y * width + x + 1], black[(y + 1) * width + x], black[(y + 1) * width + x + 1]];
      if (cell.some((value) => value < low || value > high)) continue;
      for (let k = 0; k < cell.length; k += 1) {
        const channel = channelAt(bayer, x + (k & 1), y + (k >> 1));
        sums[channel] += cell[k];
        counts[channel] += 1;
      }
    }
  }
  if (counts.some((count) => count === 0)) return [1, 1, 1];
  const means = sums.map((sum, channel) => sum / counts[channel]);
  const gain = (mean: number) => Math.min(WB_MAX_GAIN, Math.max(WB_MIN_GAIN, means[1] / mean));
  return [gain(means[0]), 1, gain(means[2])];
}

/** Reflects an index into [0, size) without changing its parity (size is even), keeping the Bayer phase. */
function mirror(index: number, size: number): number {
  if (index < 0) return -index;
  if (index >= size) return 2 * (size - 1) - index;
  return index;
}

const MHC_RADIUS = 2;

/**
 * Malvar-He-Cutler (2004) gradient-corrected linear demosaic of 16-bit linear Bayer samples.
 * Returns interleaved linear 16-bit RGB.
 */
export function demosaicMalvarHeCutler(cfa: Uint16Array, width: number, height: number, bayer: BayerOrder): Uint16Array {
  const padded = width + 2 * MHC_RADIUS;
  const plane = new Int32Array(padded * (height + 2 * MHC_RADIUS));
  for (let y = -MHC_RADIUS; y < height + MHC_RADIUS; y += 1) {
    const sourceRow = mirror(y, height) * width;
    const targetRow = (y + MHC_RADIUS) * padded + MHC_RADIUS;
    for (let x = -MHC_RADIUS; x < width + MHC_RADIUS; x += 1) {
      plane[targetRow + x] = cfa[sourceRow + mirror(x, width)];
    }
  }

  const rgb = new Uint16Array(width * height * RGB_CHANNELS);
  const row2 = padded * 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = (y + MHC_RADIUS) * padded + x + MHC_RADIUS;
      const center = plane[c];
      const left = plane[c - 1];
      const right = plane[c + 1];
      const up = plane[c - padded];
      const down = plane[c + padded];
      const left2 = plane[c - 2];
      const right2 = plane[c + 2];
      const up2 = plane[c - row2];
      const down2 = plane[c + row2];
      const diagonals = plane[c - padded - 1] + plane[c - padded + 1] + plane[c + padded - 1] + plane[c + padded + 1];
      const cross = left + right + up + down;
      const colour = channelAt(bayer, x, y);
      const out = (y * width + x) * RGB_CHANNELS;
      let r: number;
      let g: number;
      let b: number;
      if (colour === 1) {
        g = center;
        const horizontalIsRed = channelAt(bayer, x + 1, y) === 0;
        const horizontalNeighbours =
          (5 * center - diagonals + 0.5 * (up2 + down2) + 4 * (left + right) - left2 - right2) / 8;
        const verticalNeighbours =
          (5 * center - diagonals + 0.5 * (left2 + right2) + 4 * (up + down) - up2 - down2) / 8;
        r = horizontalIsRed ? horizontalNeighbours : verticalNeighbours;
        b = horizontalIsRed ? verticalNeighbours : horizontalNeighbours;
      } else {
        const greenAtCell = (4 * center + 2 * cross - left2 - right2 - up2 - down2) / 8;
        const oppositeAtCell = (6 * center + 2 * diagonals - 1.5 * (left2 + right2 + up2 + down2)) / 8;
        g = greenAtCell;
        r = colour === 0 ? center : oppositeAtCell;
        b = colour === 2 ? center : oppositeAtCell;
      }
      rgb[out] = clamp16(r);
      rgb[out + 1] = clamp16(g);
      rgb[out + 2] = clamp16(b);
    }
  }
  return rgb;
}

const EXPOSURE_SAMPLE_STEP = 7;

/** Exposure multiplier for the white-balanced samples, estimated on a regular subsample. */
function sampledExposureScale(cfa: Uint16Array): number {
  const sampled = new Float32Array(Math.ceil(cfa.length / EXPOSURE_SAMPLE_STEP));
  for (let i = 0; i < sampled.length; i += 1) sampled[i] = cfa[i * EXPOSURE_SAMPLE_STEP] / MAX_SAMPLE_16;
  return exposureScale(sampled);
}

/** Decodes a Raspberry Pi RAW frame (JPEG + BRCM trailer) into gamma-encoded 16-bit sRGB. */
export function decodeBrcmRaw(file: Buffer): DecodedRgb16 {
  const trailer = findBrcmTrailer(file);
  if (trailer < 0) throw new RawDecodeError('The file has no Raspberry Pi "BRCM" sensor block', true);
  const frame = parseBrcmHeader(file, trailer);
  const { width, height, bayer } = frame;
  const blackLevel = sensorOf(frame.sensor)!.blackLevel;
  const whiteRange = SENSOR_MAX_VALUE - blackLevel;

  const raw = unpackRaw10(file, frame);
  const levels = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) levels[i] = Math.max(0, raw[i] - blackLevel);

  const gains = estimateWhiteBalance(levels, whiteRange, width, height, bayer);
  const cfa = new Uint16Array(raw.length);
  const toFullScale = MAX_SAMPLE_16 / whiteRange;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      cfa[index] = clamp16(levels[index] * gains[channelAt(bayer, x, y)] * toFullScale);
    }
  }
  const exposure = sampledExposureScale(cfa);
  if (exposure !== 1) {
    for (let i = 0; i < cfa.length; i += 1) cfa[i] = clamp16(cfa[i] * exposure);
  }

  const rgb16 = demosaicMalvarHeCutler(cfa, width, height, bayer);
  applyMatrixAndSrgbEncode(rgb16, CFA_SATURATION_MATRIX);
  return { width, height, rgb16 };
}
