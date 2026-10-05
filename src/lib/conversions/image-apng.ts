import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ConversionFailedError, EngineUnavailableError } from '../types';
import type { RawFrame } from './image-animation';

/**
 * Animated PNG (APNG 1.0) support. libvips reads only the default image of an APNG, so the structure
 * (frame count, delays, loop count) is parsed here and the composited frames are decoded by FFmpeg's APNG
 * decoder.
 */

const execFileAsync = promisify(execFile);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD = 12;
const PNG_CHUNK_DATA_OFFSET = 8;
const PNG_TYPE_OFFSET = 4;
const IHDR_WIDTH_OFFSET = 0;
const IHDR_HEIGHT_OFFSET = 4;
const ACTL_FRAMES_OFFSET = 0;
const ACTL_PLAYS_OFFSET = 4;
const ACTL_MIN_LENGTH = 8;
const FCTL_DELAY_NUM_OFFSET = 20;
const FCTL_DELAY_DEN_OFFSET = 22;
const FCTL_LENGTH = 26;
const APNG_DEFAULT_DELAY_DENOMINATOR = 100;
const MS_PER_SECOND = 1000;
const RGBA_CHANNELS = 4;
/** Upper bound for the decoded RGBA frames of one APNG (all frames are held in memory). */
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 120_000;
const FFMPEG_PATHS = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];

export interface ApngInfo {
  width: number;
  height: number;
  frameCount: number;
  /** Total plays; 0 repeats forever. */
  plays: number;
  delaysMs: number[];
  /** True when the default image (first IDAT) is also frame 1, so libvips' decode of it equals frame 1. */
  defaultImageIsFirstFrame: boolean;
}

/** Parses the animation structure of a PNG; null for a plain PNG or a single-frame APNG. */
export function parseApng(buffer: Buffer): ApngInfo | null {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  let pos = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let frameCount = 0;
  let plays = 0;
  let sawIdat = false;
  let defaultImageIsFirstFrame = false;
  const delaysMs: number[] = [];
  while (pos + PNG_CHUNK_OVERHEAD <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + PNG_TYPE_OFFSET, pos + PNG_CHUNK_DATA_OFFSET);
    const data = buffer.subarray(pos + PNG_CHUNK_DATA_OFFSET, pos + PNG_CHUNK_DATA_OFFSET + length);
    if (type === 'IHDR' && length >= IHDR_HEIGHT_OFFSET + 4) {
      width = data.readUInt32BE(IHDR_WIDTH_OFFSET);
      height = data.readUInt32BE(IHDR_HEIGHT_OFFSET);
    } else if (type === 'acTL' && length >= ACTL_MIN_LENGTH) {
      frameCount = data.readUInt32BE(ACTL_FRAMES_OFFSET);
      plays = data.readUInt32BE(ACTL_PLAYS_OFFSET);
    } else if (type === 'IDAT') {
      sawIdat = true;
    } else if (type === 'fcTL' && length >= FCTL_LENGTH) {
      if (!sawIdat && delaysMs.length === 0) defaultImageIsFirstFrame = true;
      const numerator = data.readUInt16BE(FCTL_DELAY_NUM_OFFSET);
      const denominator = data.readUInt16BE(FCTL_DELAY_DEN_OFFSET) || APNG_DEFAULT_DELAY_DENOMINATOR;
      delaysMs.push(Math.round((numerator * MS_PER_SECOND) / denominator));
    } else if (type === 'IEND') {
      break;
    }
    pos += PNG_CHUNK_OVERHEAD + length;
  }
  if (frameCount <= 1) return null;
  if (delaysMs.length !== frameCount || width <= 0 || height <= 0) {
    throw new ConversionFailedError(
      `Malformed animated PNG: acTL announces ${frameCount} frames but ${delaysMs.length} frame control chunks were found`
    );
  }
  return { width, height, frameCount, plays, delaysMs, defaultImageIsFirstFrame };
}

function resolveFfmpeg(): string | null {
  const override = process.env.FFMPEG_PATH;
  if (override !== undefined && override !== '' && override !== 'undefined') {
    return path.isAbsolute(override) && fs.existsSync(override) ? override : null;
  }
  return FFMPEG_PATHS.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Decodes every composited frame of an APNG to RGBA with FFmpeg's APNG decoder. */
export async function decodeApngFrames(buffer: Buffer, info: ApngInfo): Promise<RawFrame[]> {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    throw new EngineUnavailableError('ffmpeg', 'decoding the frames of an animated PNG needs FFmpeg');
  }
  const frameBytes = info.width * info.height * RGBA_CHANNELS;
  if (frameBytes * info.frameCount > MAX_DECODED_BYTES) {
    throw new ConversionFailedError(
      `Animated PNG of ${info.frameCount} frames at ${info.width}x${info.height} is too large to decode in memory`
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apng-'), { encoding: 'utf8' });
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'input.apng');
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    const { stdout } = await execFileAsync(
      ffmpeg,
      ['-v', 'error', '-f', 'apng', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-fps_mode', 'passthrough', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: frameBytes * info.frameCount + frameBytes, timeout: FFMPEG_TIMEOUT_MS }
    );
    if (stdout.length !== frameBytes * info.frameCount) {
      throw new ConversionFailedError(
        `FFmpeg decoded ${stdout.length} bytes from the animated PNG, expected ${info.frameCount} frames of ${frameBytes} bytes`
      );
    }
    return Array.from({ length: info.frameCount }, (_unused, index) => ({
      data: Buffer.from(stdout.subarray(index * frameBytes, (index + 1) * frameBytes)),
      width: info.width,
      height: info.height,
    }));
  } catch (err: unknown) {
    if (err instanceof ConversionFailedError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConversionFailedError(`FFmpeg could not decode the animated PNG: ${detail}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
