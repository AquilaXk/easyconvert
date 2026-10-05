import sharp from 'sharp';
import { ConversionFailedError } from '../types';

/**
 * Animated GIF and WebP assembly from decoded frames.
 *
 * libvips writes an animation only from a decoded animation (it needs the page height that a loaded GIF or
 * WebP carries), so frames that were decoded or transformed one by one (orientation, APNG) are encoded as
 * single images by sharp and joined here at container level: GIF89a blocks (ISO-independent, CompuServe
 * specification plus the NETSCAPE2.0 loop extension) and the WebP extended format (RIFF, VP8X/ANIM/ANMF).
 * The per-frame pixel data is never re-encoded by the muxers.
 */

/** One decoded frame: 8-bit RGBA, row-major. */
export interface RawFrame {
  data: Buffer;
  width: number;
  height: number;
}

export interface AnimationTiming {
  /** Per-frame display time in milliseconds. */
  delaysMs: number[];
  /** Total plays: 0 repeats forever, 1 plays once. */
  loop: number;
}

export interface AnimationEncodeOptions {
  quality: number;
  colours: number;
  dither: number;
}

const RGBA_CHANNELS = 4;

// ---- GIF -------------------------------------------------------------------------------------------------
const GIF_SIGNATURE = 'GIF89a';
const GIF_MAGIC = 'GIF';
const GIF_HEADER_BYTES = 6;
const GIF_LSD_BYTES = 7;
const GIF_BLOCK_EXTENSION = 0x21;
const GIF_BLOCK_IMAGE = 0x2c;
const GIF_BLOCK_TRAILER = 0x3b;
const GIF_LABEL_GRAPHIC_CONTROL = 0xf9;
const GIF_LABEL_APPLICATION = 0xff;
const GIF_COLOUR_TABLE_FLAG = 0x80;
const GIF_COLOUR_TABLE_SIZE_MASK = 0x07;
const GIF_COLOUR_RESOLUTION_BITS = 0x70;
const GIF_RGB_BYTES = 3;
const GIF_IMAGE_DESCRIPTOR_BYTES = 9;
const GIF_GCE_TRANSPARENT_FLAG = 0x01;
const GIF_GCE_DISPOSAL_SHIFT = 2;
const GIF_DISPOSAL_KEEP = 1;
const GIF_DISPOSAL_RESTORE_BACKGROUND = 2;
const GIF_CENTISECOND_MS = 10;
const GIF_MAX_DELAY_CS = 0xffff;
const GIF_MAX_LOOP_FIELD = 0xffff;
const NETSCAPE_ID = 'NETSCAPE2.0';
const NETSCAPE_SUBBLOCK_LOOP = 1;
const SINGLE_PLAY = 1;

interface ParsedGifFrame {
  descriptor: Buffer;
  colourTable: Buffer;
  imageData: Buffer;
  transparentIndex: number | null;
}

function readColourTable(gif: Buffer, at: number, packed: number): { table: Buffer; next: number } {
  if ((packed & GIF_COLOUR_TABLE_FLAG) === 0) return { table: Buffer.alloc(0), next: at };
  const entries = 2 ** ((packed & GIF_COLOUR_TABLE_SIZE_MASK) + 1);
  const bytes = entries * GIF_RGB_BYTES;
  return { table: gif.subarray(at, at + bytes), next: at + bytes };
}

function skipSubBlocks(gif: Buffer, from: number): number {
  let pos = from;
  while (pos < gif.length && gif[pos] !== 0) pos += gif[pos] + 1;
  return pos + 1;
}

/** Extracts the single image of a one-frame GIF produced by the encoder. */
function parseSingleFrameGif(gif: Buffer): ParsedGifFrame {
  if (gif.toString('latin1', 0, GIF_MAGIC.length) !== GIF_MAGIC) {
    throw new ConversionFailedError('The GIF frame encoder returned data that is not a GIF');
  }
  const lsdPacked = gif[GIF_HEADER_BYTES + 4];
  const global = readColourTable(gif, GIF_HEADER_BYTES + GIF_LSD_BYTES, lsdPacked);
  let pos = global.next;
  let transparentIndex: number | null = null;
  while (pos < gif.length) {
    const block = gif[pos];
    if (block === GIF_BLOCK_TRAILER) break;
    if (block === GIF_BLOCK_EXTENSION) {
      const label = gif[pos + 1];
      if (label === GIF_LABEL_GRAPHIC_CONTROL && (gif[pos + 3] & GIF_GCE_TRANSPARENT_FLAG) !== 0) {
        transparentIndex = gif[pos + 6];
      }
      pos = skipSubBlocks(gif, pos + 2);
      continue;
    }
    if (block !== GIF_BLOCK_IMAGE) throw new ConversionFailedError('The GIF frame encoder returned a malformed GIF');
    const descriptor = Buffer.from(gif.subarray(pos + 1, pos + 1 + GIF_IMAGE_DESCRIPTOR_BYTES));
    const local = readColourTable(gif, pos + 1 + GIF_IMAGE_DESCRIPTOR_BYTES, descriptor[GIF_IMAGE_DESCRIPTOR_BYTES - 1]);
    const dataStart = local.next;
    const dataEnd = skipSubBlocks(gif, dataStart + 1);
    const colourTable = local.table.length > 0 ? local.table : global.table;
    if (colourTable.length === 0) throw new ConversionFailedError('The GIF frame encoder returned a frame without a colour table');
    return { descriptor, colourTable, imageData: gif.subarray(dataStart, dataEnd), transparentIndex };
  }
  throw new ConversionFailedError('The GIF frame encoder returned a GIF without an image');
}

function colourTableSizeBits(table: Buffer): number {
  const entries = table.length / GIF_RGB_BYTES;
  return Math.log2(entries) - 1;
}

function gifLoopField(loop: number): number {
  return loop === 0 ? 0 : Math.min(loop - 1, GIF_MAX_LOOP_FIELD);
}

function gifGraphicControl(delayMs: number, frame: ParsedGifFrame): Buffer {
  const hasTransparency = frame.transparentIndex !== null;
  const disposal = hasTransparency ? GIF_DISPOSAL_RESTORE_BACKGROUND : GIF_DISPOSAL_KEEP;
  const delayCs = Math.min(GIF_MAX_DELAY_CS, Math.round(delayMs / GIF_CENTISECOND_MS));
  const gce = Buffer.from([GIF_BLOCK_EXTENSION, GIF_LABEL_GRAPHIC_CONTROL, 4, 0, 0, 0, frame.transparentIndex ?? 0, 0]);
  gce[3] = (disposal << GIF_GCE_DISPOSAL_SHIFT) | (hasTransparency ? GIF_GCE_TRANSPARENT_FLAG : 0);
  gce.writeUInt16LE(delayCs, 4);
  return gce;
}

function gifImageBlock(frame: ParsedGifFrame): Buffer {
  const descriptor = Buffer.from(frame.descriptor);
  const interlace = descriptor[GIF_IMAGE_DESCRIPTOR_BYTES - 1] & 0x40;
  descriptor[GIF_IMAGE_DESCRIPTOR_BYTES - 1] = GIF_COLOUR_TABLE_FLAG | interlace | colourTableSizeBits(frame.colourTable);
  return Buffer.concat([Buffer.from([GIF_BLOCK_IMAGE]), descriptor, frame.colourTable, frame.imageData]);
}

async function encodeGif(frames: RawFrame[], timing: AnimationTiming, options: AnimationEncodeOptions): Promise<Buffer> {
  const parsed: ParsedGifFrame[] = [];
  for (const frame of frames) {
    const single = await sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: RGBA_CHANNELS } })
      .gif({ colours: options.colours, dither: options.dither })
      .toBuffer();
    parsed.push(parseSingleFrameGif(single));
  }
  const { width, height } = frames[0];
  const header = Buffer.alloc(GIF_HEADER_BYTES + GIF_LSD_BYTES);
  header.write(GIF_SIGNATURE, 0, 'latin1');
  header.writeUInt16LE(width, GIF_HEADER_BYTES);
  header.writeUInt16LE(height, GIF_HEADER_BYTES + 2);
  header[GIF_HEADER_BYTES + 4] = GIF_COLOUR_RESOLUTION_BITS; // no global colour table; every frame carries its own
  const parts: Buffer[] = [header];
  if (timing.loop !== SINGLE_PLAY) {
    const netscape = Buffer.alloc(19);
    netscape.set([GIF_BLOCK_EXTENSION, GIF_LABEL_APPLICATION, NETSCAPE_ID.length], 0);
    netscape.write(NETSCAPE_ID, 3, 'latin1');
    netscape.set([3, NETSCAPE_SUBBLOCK_LOOP], 14);
    netscape.writeUInt16LE(gifLoopField(timing.loop), 16);
    parts.push(netscape);
  }
  parsed.forEach((frame, index) => {
    parts.push(gifGraphicControl(timing.delaysMs[index], frame), gifImageBlock(frame));
  });
  parts.push(Buffer.from([GIF_BLOCK_TRAILER]));
  return Buffer.concat(parts);
}

// ---- WebP ------------------------------------------------------------------------------------------------
const RIFF_HEADER_BYTES = 12;
const RIFF_CHUNK_HEADER_BYTES = 8;
const WEBP_FLAG_ANIMATION = 0x02;
const WEBP_FLAG_ALPHA = 0x10;
const WEBP_ANMF_DO_NOT_BLEND = 0x02;
const WEBP_UINT24_BYTES = 3;
const WEBP_MAX_DURATION_MS = 0xffffff;
const WEBP_MAX_LOOP = 0xffff;
const WEBP_IMAGE_CHUNKS: ReadonlySet<string> = new Set(['ALPH', 'VP8 ', 'VP8L']);

function riffChunk(type: string, payload: Buffer): Buffer {
  const padded = payload.length % 2 === 0 ? payload : Buffer.concat([payload, Buffer.alloc(1)]);
  const head = Buffer.alloc(RIFF_CHUNK_HEADER_BYTES);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, padded]);
}

function writeUInt24LE(target: Buffer, value: number, at: number): void {
  target.writeUIntLE(value, at, WEBP_UINT24_BYTES);
}

/** Image chunks (ALPH, VP8, VP8L) of a single-frame WebP, with their headers, in file order. */
function webpImageChunks(webp: Buffer): { chunks: Buffer; hasAlpha: boolean } {
  if (webp.toString('latin1', 0, 4) !== 'RIFF' || webp.toString('latin1', 8, 12) !== 'WEBP') {
    throw new ConversionFailedError('The WebP frame encoder returned data that is not a WebP');
  }
  const kept: Buffer[] = [];
  let hasAlpha = false;
  let pos = RIFF_HEADER_BYTES;
  while (pos + RIFF_CHUNK_HEADER_BYTES <= webp.length) {
    const type = webp.toString('latin1', pos, pos + 4);
    const length = webp.readUInt32LE(pos + 4);
    const end = pos + RIFF_CHUNK_HEADER_BYTES + length + (length % 2);
    if (WEBP_IMAGE_CHUNKS.has(type)) kept.push(webp.subarray(pos, end));
    if (type === 'VP8X' && (webp[pos + RIFF_CHUNK_HEADER_BYTES] & WEBP_FLAG_ALPHA) !== 0) hasAlpha = true;
    if (type === 'VP8L') hasAlpha = true;
    pos = end;
  }
  if (kept.length === 0) throw new ConversionFailedError('The WebP frame encoder returned a WebP without image data');
  return { chunks: Buffer.concat(kept), hasAlpha };
}

async function encodeWebp(frames: RawFrame[], timing: AnimationTiming, options: AnimationEncodeOptions): Promise<Buffer> {
  const { width, height } = frames[0];
  const anmf: Buffer[] = [];
  let anyAlpha = false;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const single = await sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: RGBA_CHANNELS } })
      .webp({ quality: options.quality })
      .toBuffer();
    const image = webpImageChunks(single);
    anyAlpha = anyAlpha || image.hasAlpha;
    const header = Buffer.alloc(16);
    // Frame X and Y stay 0 (stored in units of two pixels).
    writeUInt24LE(header, frame.width - 1, 6);
    writeUInt24LE(header, frame.height - 1, 9);
    writeUInt24LE(header, Math.min(WEBP_MAX_DURATION_MS, timing.delaysMs[index]), 12);
    header[15] = WEBP_ANMF_DO_NOT_BLEND;
    anmf.push(riffChunk('ANMF', Buffer.concat([header, image.chunks])));
  }
  const vp8x = Buffer.alloc(10);
  vp8x[0] = WEBP_FLAG_ANIMATION | (anyAlpha ? WEBP_FLAG_ALPHA : 0);
  writeUInt24LE(vp8x, width - 1, 4);
  writeUInt24LE(vp8x, height - 1, 7);
  const anim = Buffer.alloc(6);
  anim.writeUInt16LE(Math.min(timing.loop, WEBP_MAX_LOOP), 4); // background colour stays 0 (transparent black)
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), riffChunk('VP8X', vp8x), riffChunk('ANIM', anim), ...anmf]);
  const riff = Buffer.alloc(RIFF_CHUNK_HEADER_BYTES);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/**
 * Encodes decoded frames as an animated GIF or WebP that keeps the given per-frame delays and loop count.
 * All frames must share one size.
 */
export async function assembleAnimation(
  frames: RawFrame[],
  timing: AnimationTiming,
  target: 'gif' | 'webp',
  options: AnimationEncodeOptions
): Promise<Buffer> {
  if (frames.length === 0) throw new ConversionFailedError('Cannot assemble an animation without frames');
  if (timing.delaysMs.length !== frames.length) {
    throw new ConversionFailedError(`Expected ${frames.length} frame delays but received ${timing.delaysMs.length}`);
  }
  const { width, height } = frames[0];
  if (frames.some((frame) => frame.width !== width || frame.height !== height)) {
    throw new ConversionFailedError('Animation frames must all have the same size');
  }
  return target === 'gif' ? encodeGif(frames, timing, options) : encodeWebp(frames, timing, options);
}
