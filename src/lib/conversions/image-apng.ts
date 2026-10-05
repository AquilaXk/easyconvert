import sharp from 'sharp';
import { ConversionFailedError } from '../types';
import { crc32 } from './archive';
import { RGBA_BYTES_PER_PIXEL } from './image-limits';

/**
 * Animated PNG (APNG 1.0) decoding in process.
 *
 * libvips reads only the default image of an APNG. The chunk stream is therefore validated here (CRC of every
 * chunk, fcTL/fdAT sequence numbers 0, 1, 2 ..., chunk bounds, frame regions inside the canvas), each frame is
 * rebuilt as a standalone PNG (IHDR with the frame size, the shared pre-IDAT chunks, the frame's data as
 * IDAT) and decoded by sharp, and the decoded frames are composited on the canvas with the dispose and blend
 * operations of the specification. A default image without an fcTL before its IDAT is not part of the
 * animation: it is the still result when no frame is chosen and is left out of animated output.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_OVERHEAD = 12;
const CHUNK_LENGTH_BYTES = 4;
const CHUNK_DATA_OFFSET = 8;
const CHUNK_CRC_BYTES = 4;
/** PNG chunk lengths are limited to 2^31 - 1. */
const MAX_CHUNK_LENGTH = 0x7fffffff;

const IHDR_LENGTH = 13;
const ACTL_LENGTH = 8;
const FCTL_LENGTH = 26;
const SEQUENCE_BYTES = 4;
const IHDR_BIT_DEPTH_OFFSET = 8;
const IHDR_COLOUR_TYPE_OFFSET = 9;
const IHDR_INTERLACE_OFFSET = 12;

const FCTL_WIDTH_OFFSET = 4;
const FCTL_HEIGHT_OFFSET = 8;
const FCTL_X_OFFSET = 12;
const FCTL_Y_OFFSET = 16;
const FCTL_DELAY_NUM_OFFSET = 20;
const FCTL_DELAY_DEN_OFFSET = 22;
const FCTL_DISPOSE_OFFSET = 24;
const FCTL_BLEND_OFFSET = 25;

const APNG_DEFAULT_DELAY_DENOMINATOR = 100;
const MS_PER_SECOND = 1000;

export const DISPOSE_NONE = 0;
export const DISPOSE_BACKGROUND = 1;
export const DISPOSE_PREVIOUS = 2;
export const BLEND_SOURCE = 0;
export const BLEND_OVER = 1;

const OPAQUE = 255;
const ALPHA_SCALE = 255;
const CHANNELS = 4;
const ALPHA_OFFSET = 3;

const KEPT_BEFORE_IDAT: ReadonlySet<string> = new Set(['PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'cICP', 'mDCV', 'cLLI']);

interface ByteRange {
  start: number;
  end: number;
}

export interface ApngFrame {
  width: number;
  height: number;
  x: number;
  y: number;
  delayMs: number;
  dispose: number;
  blend: number;
  /** Compressed image data (IDAT payloads or fdAT payloads without the sequence number), in file order. */
  data: ByteRange[];
}

export interface ApngAnimation {
  buffer: Buffer;
  width: number;
  height: number;
  frameCount: number;
  /** Total plays; 0 repeats forever. */
  plays: number;
  /** True when the default image is also frame 1 (an fcTL precedes the first IDAT). */
  defaultIsFirstFrame: boolean;
  frames: ApngFrame[];
  delaysMs: number[];
  ihdr: Buffer;
  /** Whole chunks (length, type, data, CRC) copied into every rebuilt frame. */
  sharedChunks: ByteRange[];
}

export function malformed(detail: string): ConversionFailedError {
  return new ConversionFailedError(`Malformed animated PNG: ${detail}`);
}

/** Reads the acTL frame count when one precedes the first IDAT; undefined for a PNG that is not animated. */
function announcedFrames(buffer: Buffer): number | undefined {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  let pos = PNG_SIGNATURE.length;
  while (pos + CHUNK_OVERHEAD <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + CHUNK_LENGTH_BYTES, pos + CHUNK_DATA_OFFSET);
    if (type === 'acTL') {
      return length >= ACTL_LENGTH && pos + CHUNK_DATA_OFFSET + ACTL_LENGTH <= buffer.length
        ? buffer.readUInt32BE(pos + CHUNK_DATA_OFFSET)
        : Number.MAX_SAFE_INTEGER;
    }
    if (type === 'IDAT') return undefined;
    pos += CHUNK_OVERHEAD + length;
  }
  return undefined;
}

interface ParseState {
  expectedSequence: number;
  sawIhdr: boolean;
  sawActl: boolean;
  sawIdat: boolean;
  idatEnded: boolean;
  sawIend: boolean;
  announced: number;
  plays: number;
  width: number;
  height: number;
  ihdr: Buffer;
  frames: ApngFrame[];
  current: ApngFrame | undefined;
  currentIsDefault: boolean;
  sharedChunks: ByteRange[];
  defaultIsFirstFrame: boolean;
}

function takeSequence(state: ParseState, buffer: Buffer, at: number, type: string): void {
  const sequence = buffer.readUInt32BE(at);
  if (sequence !== state.expectedSequence) {
    throw malformed(`${type} sequence number ${sequence} where ${state.expectedSequence} was expected`);
  }
  state.expectedSequence += 1;
}

function readFrameControl(state: ParseState, buffer: Buffer, dataAt: number, length: number): ApngFrame {
  if (length !== FCTL_LENGTH) throw malformed(`fcTL chunk is ${length} bytes instead of ${FCTL_LENGTH}`);
  takeSequence(state, buffer, dataAt, 'fcTL');
  const width = buffer.readUInt32BE(dataAt + FCTL_WIDTH_OFFSET);
  const height = buffer.readUInt32BE(dataAt + FCTL_HEIGHT_OFFSET);
  const x = buffer.readUInt32BE(dataAt + FCTL_X_OFFSET);
  const y = buffer.readUInt32BE(dataAt + FCTL_Y_OFFSET);
  const delayNumerator = buffer.readUInt16BE(dataAt + FCTL_DELAY_NUM_OFFSET);
  const delayDenominator = buffer.readUInt16BE(dataAt + FCTL_DELAY_DEN_OFFSET) || APNG_DEFAULT_DELAY_DENOMINATOR;
  const dispose = buffer[dataAt + FCTL_DISPOSE_OFFSET];
  const blend = buffer[dataAt + FCTL_BLEND_OFFSET];
  const index = state.frames.length + 1;
  if (width < 1 || height < 1) throw malformed(`frame ${index} is ${width}x${height}`);
  if (x + width > state.width || y + height > state.height) {
    throw malformed(`frame ${index} (${width}x${height} at ${x},${y}) does not fit the ${state.width}x${state.height} canvas`);
  }
  if (state.frames.length === 0 && (width !== state.width || height !== state.height || x !== 0 || y !== 0)) {
    throw malformed('the first frame must cover the whole canvas');
  }
  if (dispose > DISPOSE_PREVIOUS) throw malformed(`frame ${index} has dispose operation ${dispose}`);
  if (blend > BLEND_OVER) throw malformed(`frame ${index} has blend operation ${blend}`);
  return {
    width,
    height,
    x,
    y,
    delayMs: Math.round((delayNumerator * MS_PER_SECOND) / delayDenominator),
    dispose,
    blend,
    data: [],
  };
}

function readChunk(state: ParseState, buffer: Buffer, pos: number): number {
  if (pos + CHUNK_OVERHEAD > buffer.length) throw malformed('the file ends inside a chunk header');
  const length = buffer.readUInt32BE(pos);
  const type = buffer.toString('latin1', pos + CHUNK_LENGTH_BYTES, pos + CHUNK_DATA_OFFSET);
  if (length > MAX_CHUNK_LENGTH) throw malformed(`${type} chunk declares ${length} bytes, over the PNG limit`);
  const dataAt = pos + CHUNK_DATA_OFFSET;
  const end = dataAt + length + CHUNK_CRC_BYTES;
  if (end > buffer.length) throw malformed(`${type} chunk of ${length} bytes runs past the end of the file`);
  if (crc32(buffer.subarray(pos + CHUNK_LENGTH_BYTES, dataAt + length)) !== buffer.readUInt32BE(dataAt + length)) {
    throw malformed(`CRC mismatch in ${type} chunk`);
  }
  if (!state.sawIhdr && type !== 'IHDR') throw malformed('the first chunk is not IHDR');
  if (state.idatEnded && type === 'IDAT') throw malformed('IDAT chunks are not contiguous');
  if (state.sawIdat && type !== 'IDAT' && type !== 'IEND') state.idatEnded = true;
  readTypedChunk(state, buffer, type, pos, dataAt, length);
  return end;
}

function readTypedChunk(state: ParseState, buffer: Buffer, type: string, pos: number, dataAt: number, length: number): void {
  const whole: ByteRange = { start: pos, end: dataAt + length + CHUNK_CRC_BYTES };
  switch (type) {
    case 'IHDR':
      if (state.sawIhdr || length !== IHDR_LENGTH) throw malformed('IHDR chunk is missing, repeated or not 13 bytes');
      state.sawIhdr = true;
      state.width = buffer.readUInt32BE(dataAt);
      state.height = buffer.readUInt32BE(dataAt + CHUNK_CRC_BYTES);
      if (state.width < 1 || state.height < 1) throw malformed(`canvas is ${state.width}x${state.height}`);
      state.ihdr = buffer.subarray(dataAt, dataAt + length);
      return;
    case 'acTL':
      if (state.sawActl || state.sawIdat || length !== ACTL_LENGTH) throw malformed('acTL chunk is repeated, late or not 8 bytes');
      state.sawActl = true;
      state.announced = buffer.readUInt32BE(dataAt);
      state.plays = buffer.readUInt32BE(dataAt + CHUNK_CRC_BYTES);
      return;
    case 'fcTL': {
      if (!state.sawActl) throw malformed('fcTL chunk before acTL');
      const frame = readFrameControl(state, buffer, dataAt, length);
      if (!state.sawIdat && state.frames.length > 0) throw malformed('a second fcTL before the first IDAT');
      state.frames.push(frame);
      state.current = frame;
      state.currentIsDefault = !state.sawIdat;
      if (!state.sawIdat) state.defaultIsFirstFrame = true;
      return;
    }
    case 'IDAT':
      state.sawIdat = true;
      if (state.defaultIsFirstFrame && state.current && state.currentIsDefault) {
        state.current.data.push({ start: dataAt, end: dataAt + length });
      }
      return;
    case 'fdAT': {
      if (length < SEQUENCE_BYTES) throw malformed('fdAT chunk is shorter than its sequence number');
      if (!state.current || state.currentIsDefault) throw malformed('fdAT chunk without a preceding fcTL');
      takeSequence(state, buffer, dataAt, 'fdAT');
      state.current.data.push({ start: dataAt + SEQUENCE_BYTES, end: dataAt + length });
      return;
    }
    case 'IEND':
      if (length !== 0) throw malformed('IEND chunk has data');
      state.sawIend = true;
      return;
    default:
      if (!state.sawIdat && KEPT_BEFORE_IDAT.has(type)) state.sharedChunks.push(whole);
  }
}

/**
 * Parses and validates an APNG with more than one animation frame. Returns null for any other PNG (the
 * regular decoder handles those) and throws a typed error for a malformed animation.
 */
export function parseApng(buffer: Buffer): ApngAnimation | null {
  const announced = announcedFrames(buffer);
  if (announced === undefined || announced <= 1) return null;
  const state: ParseState = {
    expectedSequence: 0,
    sawIhdr: false,
    sawActl: false,
    sawIdat: false,
    idatEnded: false,
    sawIend: false,
    announced: 0,
    plays: 0,
    width: 0,
    height: 0,
    ihdr: Buffer.alloc(0),
    frames: [],
    current: undefined,
    currentIsDefault: false,
    sharedChunks: [],
    defaultIsFirstFrame: false,
  };
  let pos = PNG_SIGNATURE.length;
  while (pos < buffer.length && !state.sawIend) {
    pos = readChunk(state, buffer, pos);
  }
  if (!state.sawIend) throw malformed('the IEND chunk is missing');
  if (state.frames.length !== state.announced) {
    throw malformed(`acTL announces ${state.announced} frames but ${state.frames.length} frame control chunks were found`);
  }
  state.frames.forEach((frame, index) => {
    if (frame.data.length === 0) throw malformed(`frame ${index + 1} has no image data`);
  });
  return {
    buffer,
    width: state.width,
    height: state.height,
    frameCount: state.frames.length,
    plays: state.plays,
    defaultIsFirstFrame: state.defaultIsFirstFrame,
    frames: state.frames,
    delaysMs: state.frames.map((frame) => frame.delayMs),
    ihdr: state.ihdr,
    sharedChunks: state.sharedChunks,
  };
}

function chunkBytes(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(CHUNK_OVERHEAD + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, CHUNK_LENGTH_BYTES, 'latin1');
  data.copy(out, CHUNK_DATA_OFFSET);
  out.writeUInt32BE(crc32(out.subarray(CHUNK_LENGTH_BYTES, CHUNK_DATA_OFFSET + data.length)), CHUNK_DATA_OFFSET + data.length);
  return out;
}

/** Standalone PNG holding one frame: the frame size in IHDR, the shared chunks, the frame data as IDAT. */
function standalonePng(animation: ApngAnimation, frame: ApngFrame): Buffer {
  const ihdr = Buffer.from(animation.ihdr);
  ihdr.writeUInt32BE(frame.width, 0);
  ihdr.writeUInt32BE(frame.height, CHUNK_CRC_BYTES);
  const parts: Buffer[] = [PNG_SIGNATURE, chunkBytes('IHDR', ihdr)];
  for (const range of animation.sharedChunks) parts.push(animation.buffer.subarray(range.start, range.end));
  for (const range of frame.data) parts.push(chunkBytes('IDAT', animation.buffer.subarray(range.start, range.end)));
  parts.push(chunkBytes('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** 8-bit RGBA pixels of one frame rectangle. */
async function decodeFrame(animation: ApngAnimation, frame: ApngFrame, index: number): Promise<Buffer> {
  try {
    const { data, info } = await sharp(standalonePng(animation, frame))
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const expectedBytes = frame.width * frame.height * CHANNELS;
    if (info.width !== frame.width || info.height !== frame.height || info.channels !== CHANNELS || data.length !== expectedBytes) {
      throw malformed(`frame ${index + 1} decoded to ${info.width}x${info.height} with ${info.channels} channels`);
    }
    return data;
  } catch (err: unknown) {
    if (err instanceof ConversionFailedError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw malformed(`frame ${index + 1} cannot be decoded (${detail})`);
  }
}

/** Source-over of straight (non-premultiplied) 8-bit RGBA, per the PNG specification's alpha compositing. */
function blendOver(canvas: Buffer, at: number, source: Buffer, from: number): void {
  const sourceAlpha = source[from + ALPHA_OFFSET];
  if (sourceAlpha === 0) return;
  const canvasAlpha = canvas[at + ALPHA_OFFSET];
  if (sourceAlpha === OPAQUE || canvasAlpha === 0) {
    canvas[at] = source[from];
    canvas[at + 1] = source[from + 1];
    canvas[at + 2] = source[from + 2];
    canvas[at + ALPHA_OFFSET] = sourceAlpha;
    return;
  }
  const behind = canvasAlpha * (OPAQUE - sourceAlpha);
  const total = sourceAlpha * ALPHA_SCALE + behind;
  for (let channel = 0; channel < ALPHA_OFFSET; channel += 1) {
    canvas[at + channel] = Math.round((source[from + channel] * sourceAlpha * ALPHA_SCALE + canvas[at + channel] * behind) / total);
  }
  canvas[at + ALPHA_OFFSET] = Math.round(total / ALPHA_SCALE);
}

/**
 * Renders the animation frame by frame onto one canvas. `advance()` draws the next frame (after disposing
 * of the previous one) and `snapshot()` copies the canvas as that frame's full RGBA picture.
 */
export class ApngCompositor {
  private readonly canvas: Buffer;
  private next = 0;
  private pending: { frame: ApngFrame; saved: Buffer | undefined } | undefined;

  constructor(private readonly animation: ApngAnimation) {
    this.canvas = Buffer.alloc(animation.width * animation.height * RGBA_BYTES_PER_PIXEL);
  }

  get framesDrawn(): number {
    return this.next;
  }

  async advance(): Promise<void> {
    const index = this.next;
    const frame = this.animation.frames[index];
    this.disposePrevious();
    const pixels = await decodeFrame(this.animation, frame, index);
    const saved = frame.dispose === DISPOSE_PREVIOUS && index > 0 ? this.copyRegion(frame) : undefined;
    this.draw(frame, pixels);
    this.pending = { frame, saved };
    this.next += 1;
  }

  snapshot(): Buffer {
    return Buffer.from(this.canvas);
  }

  private rowStart(x: number, y: number): number {
    return (y * this.animation.width + x) * RGBA_BYTES_PER_PIXEL;
  }

  private copyRegion(frame: ApngFrame): Buffer {
    const rowBytes = frame.width * RGBA_BYTES_PER_PIXEL;
    const saved = Buffer.alloc(rowBytes * frame.height);
    for (let row = 0; row < frame.height; row += 1) {
      const from = this.rowStart(frame.x, frame.y + row);
      this.canvas.copy(saved, row * rowBytes, from, from + rowBytes);
    }
    return saved;
  }

  private disposePrevious(): void {
    const pending = this.pending;
    if (!pending) return;
    const { frame, saved } = pending;
    const rowBytes = frame.width * RGBA_BYTES_PER_PIXEL;
    // The first frame cannot restore a previous canvas, so PREVIOUS behaves as BACKGROUND there.
    const restores = frame.dispose === DISPOSE_PREVIOUS && saved !== undefined;
    if (frame.dispose === DISPOSE_NONE) return;
    for (let row = 0; row < frame.height; row += 1) {
      const at = this.rowStart(frame.x, frame.y + row);
      if (restores) saved.copy(this.canvas, at, row * rowBytes, (row + 1) * rowBytes);
      else this.canvas.fill(0, at, at + rowBytes);
    }
  }

  private draw(frame: ApngFrame, pixels: Buffer): void {
    const rowBytes = frame.width * RGBA_BYTES_PER_PIXEL;
    for (let row = 0; row < frame.height; row += 1) {
      const at = this.rowStart(frame.x, frame.y + row);
      const from = row * rowBytes;
      if (frame.blend === BLEND_SOURCE) {
        pixels.copy(this.canvas, at, from, from + rowBytes);
        continue;
      }
      for (let column = 0; column < frame.width; column += 1) {
        blendOver(this.canvas, at + column * RGBA_BYTES_PER_PIXEL, pixels, from + column * RGBA_BYTES_PER_PIXEL);
      }
    }
  }
}
