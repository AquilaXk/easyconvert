import { ConversionFailedError, UnsupportedOptionError } from '../types';

/**
 * Flat Adobe Photoshop (PSD, version 1) writer, after "Adobe Photoshop File Formats Specification".
 *
 * Layout: file header, empty colour-mode data, image resources (resolution 1005, ICC profile 1039), layer and mask
 * information, then the merged image as planar PackBits channels. A picture with alpha carries one layer whose
 * negative layer count tells readers that the first extra channel of the merged image is transparency; a picture
 * without alpha has an empty layer section.
 */

/** A PSD (version 1) holds 1 to 30000 pixels per side. */
export const PSD_MAX_SIDE = 30_000;

const PSD_HEADER_BYTES = 26;
const PSD_VERSION = 1;
const PSD_COLOR_MODE_RGB = 3;
const PSD_COMPRESSION_RLE = 1;
const PACKBITS_MAX_RUN = 128;
const PACKBITS_MAX_LITERAL = 128;
const PACKBITS_WORST_CASE_RATIO = 2;
const BYTE_MAX = 255;
const U16_MAX = 65_535;
const BYTES_PER_U16 = 2;
const BYTES_PER_U32 = 4;
const PSD_PAD_TO = 4;
const FIXED_16_16_ONE = 0x10000;
/** Image resource ids: ResolutionInfo and the embedded ICC profile. */
const RESOURCE_RESOLUTION_INFO = 1005;
const RESOURCE_ICC_PROFILE = 1039;
const RESOLUTION_UNIT_PIXELS_PER_INCH = 1;
const RESOLUTION_UNIT_INCHES = 1;
const RESOLUTION_INFO_BYTES = 16;
const DEFAULT_DENSITY_PPI = 72;
/** Largest ICC profile this writer embeds; an image resource block length is a 32-bit field. */
export const PSD_ICC_MAX_BYTES = 16 * 1024 * 1024;
/** Layer channel ids: the layer's own transparency, then the colour channels. */
const LAYER_CHANNEL_TRANSPARENCY = -1;
const LAYER_NAME = 'Layer 1';
const LAYER_OPACITY_OPAQUE = 255;

export type PsdDepth = 8 | 16;
export type PsdChannels = 3 | 4;

export interface PsdPicture {
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGB plus alpha. */
  channels: PsdChannels;
  depth: PsdDepth;
  /**
   * Interleaved, row-major, top row first. 8-bit samples are bytes; 16-bit samples are native-endian
   * (little-endian) unsigned shorts, the layout libvips raw output uses.
   */
  samples: Uint8Array;
  icc?: Uint8Array;
  densityPpi?: number;
}

function assertPicture(picture: PsdPicture): void {
  const { width, height, channels, depth } = picture;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ConversionFailedError(`PSD encoding needs a positive integer size; the picture is ${width} x ${height}.`);
  }
  if (width > PSD_MAX_SIDE || height > PSD_MAX_SIDE) {
    throw new UnsupportedOptionError(
      `A PSD file holds at most ${PSD_MAX_SIDE} pixels on a side; the picture is ${width} x ${height}. Use a smaller size; PSB output is not supported.`
    );
  }
  if (channels !== 3 && channels !== 4) {
    throw new ConversionFailedError(`PSD encoding needs 3 or 4 channels; the picture has ${channels}.`);
  }
  if (depth !== 8 && depth !== 16) {
    throw new ConversionFailedError(`PSD encoding supports 8 and 16 bits per channel; the picture has ${depth}.`);
  }
  const expected = width * height * channels * (depth / 8);
  if (picture.samples.length !== expected) {
    throw new ConversionFailedError(`PSD encoding needs ${expected} bytes of pixels, got ${picture.samples.length}.`);
  }
  if (picture.icc && picture.icc.length > PSD_ICC_MAX_BYTES) {
    throw new ConversionFailedError(`The ICC profile is ${picture.icc.length} bytes; a PSD embeds at most ${PSD_ICC_MAX_BYTES}.`);
  }
}

/**
 * Worst-case PackBits size of a row of `length` bytes. A literal run is cut before every pair of equal bytes, so
 * the densest case is one single byte then one pair (3 bytes become 4); 2 bytes per input byte covers it.
 */
function packBitsBound(length: number): number {
  return PACKBITS_WORST_CASE_RATIO * length + 1;
}

/**
 * Encodes `row` as PackBits into `out` and returns the byte count written. A run of 2 or more equal bytes is
 * `257 - run` followed by the byte; other bytes are copied as literal runs of up to 128 (count byte `n - 1`).
 */
function packBitsRow(row: Uint8Array, out: Uint8Array): number {
  let written = 0;
  let i = 0;
  const length = row.length;
  while (i < length) {
    let run = 1;
    while (i + run < length && row[i + run] === row[i] && run < PACKBITS_MAX_RUN) run += 1;
    if (run >= 2) {
      out[written++] = 257 - run;
      out[written++] = row[i];
      i += run;
      continue;
    }
    const start = i;
    i += 1;
    while (i < length && i - start < PACKBITS_MAX_LITERAL && !(i + 1 < length && row[i] === row[i + 1])) i += 1;
    out[written++] = i - start - 1;
    out.set(row.subarray(start, i), written);
    written += i - start;
  }
  return written;
}

/** Big-endian planes of one channel, rows stacked: plane byte (y, x*bytesPerSample + k). */
function channelPlane(picture: PsdPicture, channel: number, merged: Uint8Array | null): Uint8Array {
  const { width, height, channels, depth } = picture;
  const bytesPerSample = depth / 8;
  const source = merged ?? picture.samples;
  const plane = new Uint8Array(width * height * bytesPerSample);
  const pixels = width * height;
  if (bytesPerSample === 1) {
    for (let p = 0; p < pixels; p += 1) plane[p] = source[p * channels + channel];
    return plane;
  }
  for (let p = 0; p < pixels; p += 1) {
    const at = (p * channels + channel) * BYTES_PER_U16;
    // Source samples are little-endian; the file stores big-endian.
    plane[p * BYTES_PER_U16] = source[at + 1];
    plane[p * BYTES_PER_U16 + 1] = source[at];
  }
  return plane;
}

/**
 * The merged image of a picture with alpha is stored premultiplied against white, as Photoshop writes it, so a
 * reader that ignores transparency still shows the picture on a white page.
 */
function blendAgainstWhite(picture: PsdPicture): Uint8Array {
  const { width, height, depth } = picture;
  const out = new Uint8Array(picture.samples.length);
  const pixels = width * height;
  if (depth === 8) {
    for (let p = 0; p < pixels; p += 1) {
      const at = p * 4;
      const alpha = picture.samples[at + 3];
      for (let c = 0; c < 3; c += 1) {
        out[at + c] = Math.round((picture.samples[at + c] * alpha + BYTE_MAX * (BYTE_MAX - alpha)) / BYTE_MAX);
      }
      out[at + 3] = alpha;
    }
    return out;
  }
  const view = new DataView(picture.samples.buffer, picture.samples.byteOffset, picture.samples.byteLength);
  const target = new DataView(out.buffer);
  for (let p = 0; p < pixels; p += 1) {
    const at = p * 4 * BYTES_PER_U16;
    const alpha = view.getUint16(at + 3 * BYTES_PER_U16, true);
    for (let c = 0; c < 3; c += 1) {
      const value = view.getUint16(at + c * BYTES_PER_U16, true);
      target.setUint16(at + c * BYTES_PER_U16, Math.round((value * alpha + U16_MAX * (U16_MAX - alpha)) / U16_MAX), true);
    }
    target.setUint16(at + 3 * BYTES_PER_U16, alpha, true);
  }
  return out;
}

interface PackedChannel {
  /** Per-row byte counts (2 bytes each) followed by the packed rows. */
  counts: Buffer;
  rows: Buffer;
}

function packChannel(plane: Uint8Array, width: number, height: number, bytesPerSample: number): PackedChannel {
  const rowBytes = width * bytesPerSample;
  const scratch = new Uint8Array(packBitsBound(rowBytes));
  const counts = Buffer.alloc(height * BYTES_PER_U16);
  const chunks: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const written = packBitsRow(plane.subarray(y * rowBytes, (y + 1) * rowBytes), scratch);
    counts.writeUInt16BE(written, y * BYTES_PER_U16);
    chunks.push(Buffer.from(scratch.subarray(0, written)));
  }
  return { counts, rows: Buffer.concat(chunks) };
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(BYTES_PER_U16);
  b.writeUInt16BE(value, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(BYTES_PER_U32);
  b.writeUInt32BE(value, 0);
  return b;
}

function padTo(buffer: Buffer, multiple: number): Buffer {
  const remainder = buffer.length % multiple;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(multiple - remainder)]);
}

function resourceBlock(id: number, data: Buffer): Buffer {
  // '8BIM', id, empty Pascal name padded to even (2 bytes), data length, data padded to even.
  return Buffer.concat([Buffer.from('8BIM', 'ascii'), u16(id), Buffer.alloc(2), u32(data.length), padTo(data, 2)]);
}

function fixed16(value: number): Buffer {
  return u32(Math.round(value * FIXED_16_16_ONE));
}

function imageResources(picture: PsdPicture): Buffer {
  const density = picture.densityPpi && picture.densityPpi > 0 ? picture.densityPpi : DEFAULT_DENSITY_PPI;
  const resolution = Buffer.concat([
    fixed16(density), u16(RESOLUTION_UNIT_PIXELS_PER_INCH), u16(RESOLUTION_UNIT_INCHES),
    fixed16(density), u16(RESOLUTION_UNIT_PIXELS_PER_INCH), u16(RESOLUTION_UNIT_INCHES),
  ]);
  const blocks = [resourceBlock(RESOURCE_RESOLUTION_INFO, resolution)];
  if (picture.icc && picture.icc.length > 0) blocks.push(resourceBlock(RESOURCE_ICC_PROFILE, Buffer.from(picture.icc)));
  const body = Buffer.concat(blocks);
  return Buffer.concat([u32(body.length), body]);
}

/** Layer count, the single layer record and its RLE channel data: the body of "layer info". */
function layerInfoBody(picture: PsdPicture): Buffer {
  const { width, height, depth } = picture;
  const bytesPerSample = depth / 8;
  // Layer channel order: transparency (-1), then red, green, blue.
  const order = [
    { id: LAYER_CHANNEL_TRANSPARENCY, index: 3 },
    { id: 0, index: 0 },
    { id: 1, index: 1 },
    { id: 2, index: 2 },
  ];
  const packed = order.map((c) => packChannel(channelPlane(picture, c.index, null), width, height, bytesPerSample));
  const channelData = packed.map((p) => Buffer.concat([u16(PSD_COMPRESSION_RLE), p.counts, p.rows]));

  const rect = Buffer.alloc(4 * BYTES_PER_U32);
  rect.writeInt32BE(0, 0);
  rect.writeInt32BE(0, 4);
  rect.writeInt32BE(height, 8);
  rect.writeInt32BE(width, 12);
  const channelInfos = order.map((c, i) => {
    const info = Buffer.alloc(BYTES_PER_U16 + BYTES_PER_U32);
    info.writeInt16BE(c.id, 0);
    info.writeUInt32BE(channelData[i].length, BYTES_PER_U16);
    return info;
  });
  const nameBytes = padTo(Buffer.concat([Buffer.from([LAYER_NAME.length]), Buffer.from(LAYER_NAME, 'ascii')]), PSD_PAD_TO);
  const extra = Buffer.concat([u32(0), u32(0), nameBytes]); // no layer mask, no blending ranges, the name
  const record = Buffer.concat([
    rect,
    u16(order.length),
    ...channelInfos,
    Buffer.from('8BIMnorm', 'ascii'),
    Buffer.from([LAYER_OPACITY_OPAQUE, 0, 0, 0]), // opacity, clipping, flags (visible), filler
    u32(extra.length),
    extra,
  ]);
  const count = Buffer.alloc(BYTES_PER_U16);
  count.writeInt16BE(-1, 0); // negative: the first extra channel of the merged image is transparency
  return Buffer.concat([count, record, ...channelData]);
}

function layerAndMaskSection(picture: PsdPicture): Buffer {
  if (picture.channels === 3) {
    // No layers: an empty layer info and an empty global layer mask.
    return Buffer.concat([u32(2 * BYTES_PER_U32), u32(0), u32(0)]);
  }
  const body = layerInfoBody(picture);
  if (picture.depth === 8) {
    const layerInfo = padTo(body, PSD_PAD_TO);
    const inner = Buffer.concat([u32(layerInfo.length), layerInfo, u32(0)]);
    return Buffer.concat([u32(inner.length), inner]);
  }
  // 16-bit documents keep their layer info in the 'Lr16' additional-information block.
  const block = Buffer.concat([Buffer.from('8BIMLr16', 'ascii'), u32(padTo(body, PSD_PAD_TO).length), padTo(body, PSD_PAD_TO)]);
  const inner = Buffer.concat([u32(0), u32(0), block]);
  return Buffer.concat([u32(inner.length), inner]);
}

/** Writes `picture` as a flat Photoshop file (version 1, RGB, 8 or 16 bits per channel, PackBits). */
export function encodePsd(picture: PsdPicture): Buffer {
  assertPicture(picture);
  const { width, height, channels, depth } = picture;
  const header = Buffer.alloc(PSD_HEADER_BYTES);
  header.write('8BPS', 0, 4, 'ascii');
  header.writeUInt16BE(PSD_VERSION, 4);
  header.writeUInt16BE(channels, 12);
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(depth, 22);
  header.writeUInt16BE(PSD_COLOR_MODE_RGB, 24);

  const merged = channels === 4 ? blendAgainstWhite(picture) : null;
  const bytesPerSample = depth / 8;
  const packed: PackedChannel[] = [];
  for (let c = 0; c < channels; c += 1) {
    packed.push(packChannel(channelPlane(picture, c, merged), width, height, bytesPerSample));
  }
  // Image data: one compression word, every channel's row counts, then every channel's rows.
  return Buffer.concat([
    header,
    u32(0), // colour mode data
    imageResources(picture),
    layerAndMaskSection(picture),
    u16(PSD_COMPRESSION_RLE),
    ...packed.map((p) => p.counts),
    ...packed.map((p) => p.rows),
  ]);
}
