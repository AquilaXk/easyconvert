/**
 * Independent OpenEXR 2.0 scanline writer for test inputs.
 *
 * Authored from the OpenEXR file layout specification ("Technical Introduction to OpenEXR",
 * File Layout section), not from the engine under test. It writes a single-part, scanline,
 * uncompressed image: magic and version field, a header made of typed attributes, a line offset
 * table, and one block per scanline holding every channel in channel-name order.
 */

const EXR_MAGIC = 20000630;
const EXR_VERSION = 2;
const EXR_VERSION_FLAGS_NONE = 0;
const BYTES_PER_INT32 = 4;
const BYTES_PER_OFFSET = 8;
const BYTES_PER_HALF = 2;
const BYTES_PER_FLOAT = 4;
const BOX2I_BYTES = 16;
const CHLIST_ENTRY_FIXED_BYTES = 16;

/** Pixel type codes from the specification's channel list. */
const PIXEL_TYPE_HALF = 1;
const PIXEL_TYPE_FLOAT = 2;

const COMPRESSION_NONE = 0;
const LINE_ORDER_INCREASING_Y = 0;

const FLOAT32_EXPONENT_BIAS = 127;
const HALF_EXPONENT_BIAS = 15;
const HALF_MAX_BIASED_EXPONENT = 31;
const HALF_MANTISSA_BITS = 10;
const FLOAT32_MANTISSA_BITS = 23;
const MANTISSA_SHIFT = FLOAT32_MANTISSA_BITS - HALF_MANTISSA_BITS;
const HALF_INFINITY_BITS = 0x7c00;
const HALF_NAN_BITS = 0x7e00;
const HALF_SIGN_BIT = 0x8000;
const FLOAT32_IMPLICIT_ONE = 0x800000;

export type ExrSampleType = 'half' | 'float';

export interface ExrImage {
  width: number;
  height: number;
  /** Channel names mapped to row-major planar samples (width * height values each). */
  channels: Readonly<Record<string, Float32Array>>;
  sampleType: ExrSampleType;
}

/** Converts a binary32 value to IEEE 754 binary16 bits with round-to-nearest-even. */
export function floatToHalfBits(value: number): number {
  const scratch = new DataView(new ArrayBuffer(BYTES_PER_FLOAT));
  scratch.setFloat32(0, value);
  const bits = scratch.getUint32(0);
  const sign = (bits >>> 16) & HALF_SIGN_BIT;
  const exponent = (bits >>> FLOAT32_MANTISSA_BITS) & 0xff;
  const mantissa = bits & (FLOAT32_IMPLICIT_ONE - 1);

  if (exponent === 0xff) {
    return mantissa === 0 ? sign | HALF_INFINITY_BITS : sign | HALF_NAN_BITS;
  }
  const halfExponent = exponent - FLOAT32_EXPONENT_BIAS + HALF_EXPONENT_BIAS;
  if (halfExponent >= HALF_MAX_BIASED_EXPONENT) {
    return sign | HALF_INFINITY_BITS;
  }
  if (halfExponent <= 0) {
    // Subnormal half (or zero): shift the mantissa with its implicit leading one.
    const subnormalShift = MANTISSA_SHIFT + 1 - halfExponent;
    if (subnormalShift > FLOAT32_MANTISSA_BITS + 1) return sign;
    const full = mantissa | FLOAT32_IMPLICIT_ONE;
    const kept = full >>> subnormalShift;
    const remainder = full & ((1 << subnormalShift) - 1);
    const halfway = 1 << (subnormalShift - 1);
    const roundUp = remainder > halfway || (remainder === halfway && (kept & 1) === 1);
    return sign | (kept + (roundUp ? 1 : 0));
  }
  const kept = mantissa >>> MANTISSA_SHIFT;
  const remainder = mantissa & ((1 << MANTISSA_SHIFT) - 1);
  const halfway = 1 << (MANTISSA_SHIFT - 1);
  const roundUp = remainder > halfway || (remainder === halfway && (kept & 1) === 1);
  // A mantissa carry propagates into the exponent field, which is the correct result.
  return sign | (((halfExponent << HALF_MANTISSA_BITS) | kept) + (roundUp ? 1 : 0));
}

/** Decodes IEEE 754 binary16 bits to a number (used to compute expected quantised samples). */
export function halfBitsToFloat(bits: number): number {
  const sign = bits & HALF_SIGN_BIT ? -1 : 1;
  const exponent = (bits >>> HALF_MANTISSA_BITS) & HALF_MAX_BIASED_EXPONENT;
  const mantissa = bits & ((1 << HALF_MANTISSA_BITS) - 1);
  if (exponent === 0) return sign * 2 ** (1 - HALF_EXPONENT_BIAS) * (mantissa / (1 << HALF_MANTISSA_BITS));
  if (exponent === HALF_MAX_BIASED_EXPONENT) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - HALF_EXPONENT_BIAS) * (1 + mantissa / (1 << HALF_MANTISSA_BITS));
}

function int32(value: number): Buffer {
  const buf = Buffer.alloc(BYTES_PER_INT32);
  buf.writeInt32LE(value);
  return buf;
}

function float32(value: number): Buffer {
  const buf = Buffer.alloc(BYTES_PER_FLOAT);
  buf.writeFloatLE(value);
  return buf;
}

function attribute(name: string, type: string, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${name}\0${type}\0`, 'ascii'), int32(value.length), value]);
}

function box2i(xMin: number, yMin: number, xMax: number, yMax: number): Buffer {
  return Buffer.concat([int32(xMin), int32(yMin), int32(xMax), int32(yMax)]);
}

function channelList(names: readonly string[], pixelType: number): Buffer {
  const entries = names.map((name) =>
    Buffer.concat([
      Buffer.from(`${name}\0`, 'ascii'),
      int32(pixelType),
      Buffer.from([0, 0, 0, 0]), // pLinear plus three reserved bytes
      int32(1), // xSampling
      int32(1), // ySampling
    ])
  );
  return Buffer.concat([...entries, Buffer.from([0])]);
}

/** Builds an OpenEXR 2.0 scanline image with NO_COMPRESSION. */
export function writeOpenExr(image: ExrImage): Buffer {
  const { width, height, sampleType } = image;
  const names = Object.keys(image.channels).sort();
  if (names.length === 0) throw new Error('writeOpenExr requires at least one channel');
  for (const name of names) {
    if (image.channels[name].length !== width * height) {
      throw new Error(`channel ${name} has ${image.channels[name].length} samples, expected ${width * height}`);
    }
  }
  const pixelType = sampleType === 'half' ? PIXEL_TYPE_HALF : PIXEL_TYPE_FLOAT;
  const bytesPerSample = sampleType === 'half' ? BYTES_PER_HALF : BYTES_PER_FLOAT;

  const magicAndVersion = Buffer.concat([int32(EXR_MAGIC), int32(EXR_VERSION | EXR_VERSION_FLAGS_NONE)]);
  const window = box2i(0, 0, width - 1, height - 1);
  const header = Buffer.concat([
    magicAndVersion,
    attribute('channels', 'chlist', channelList(names, pixelType)),
    attribute('compression', 'compression', Buffer.from([COMPRESSION_NONE])),
    attribute('dataWindow', 'box2i', window),
    attribute('displayWindow', 'box2i', window),
    attribute('lineOrder', 'lineOrder', Buffer.from([LINE_ORDER_INCREASING_Y])),
    attribute('pixelAspectRatio', 'float', float32(1)),
    attribute('screenWindowCenter', 'v2f', Buffer.concat([float32(0), float32(0)])),
    attribute('screenWindowWidth', 'float', float32(1)),
    Buffer.from([0]), // end of header
  ]);

  const lineDataBytes = width * bytesPerSample * names.length;
  const blockBytes = BYTES_PER_INT32 + BYTES_PER_INT32 + lineDataBytes;
  const tableBytes = height * BYTES_PER_OFFSET;
  const firstBlockOffset = header.length + tableBytes;

  const table = Buffer.alloc(tableBytes);
  const blocks = Buffer.alloc(blockBytes * height);
  for (let y = 0; y < height; y++) {
    table.writeBigUInt64LE(BigInt(firstBlockOffset + y * blockBytes), y * BYTES_PER_OFFSET);
    let pos = y * blockBytes;
    blocks.writeInt32LE(y, pos);
    blocks.writeInt32LE(lineDataBytes, pos + BYTES_PER_INT32);
    pos += BYTES_PER_INT32 + BYTES_PER_INT32;
    for (const name of names) {
      const plane = image.channels[name];
      for (let x = 0; x < width; x++) {
        const sample = plane[y * width + x];
        if (sampleType === 'half') {
          blocks.writeUInt16LE(floatToHalfBits(sample), pos);
        } else {
          blocks.writeFloatLE(sample, pos);
        }
        pos += bytesPerSample;
      }
    }
  }
  return Buffer.concat([header, table, blocks]);
}

/** Convenience: interleaved RGB samples (r,g,b per pixel) to a B/G/R channel image. */
export function writeRgbOpenExr(
  interleavedRgb: Float32Array,
  width: number,
  height: number,
  sampleType: ExrSampleType
): Buffer {
  const pixels = width * height;
  if (interleavedRgb.length !== pixels * 3) {
    throw new Error(`expected ${pixels * 3} interleaved samples, got ${interleavedRgb.length}`);
  }
  const R = new Float32Array(pixels);
  const G = new Float32Array(pixels);
  const B = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    R[i] = interleavedRgb[i * 3];
    G[i] = interleavedRgb[i * 3 + 1];
    B[i] = interleavedRgb[i * 3 + 2];
  }
  return writeOpenExr({ width, height, channels: { R, G, B }, sampleType });
}
