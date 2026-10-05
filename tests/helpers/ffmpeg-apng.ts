import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/**
 * FFmpeg's APNG decoder as the independent oracle for composited APNG frames (dispose and blend operations
 * applied per the APNG 1.0 specification) and for decoded GIF frames.
 */

export const HAS_FFMPEG = getOracleToolPath('ffmpeg') !== null;
export const SKIP_WITHOUT_FFMPEG = !HAS_FFMPEG && process.env.ORACLE_STRICT_MODE !== '1';

const RGBA_CHANNELS = 4;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface FfmpegFrames {
  width: number;
  height: number;
  /** One RGBA buffer per decoded frame, canvas-sized. */
  frames: Buffer[];
}

/** Decodes every frame of `encoded` (container named by `demuxer`, e.g. `apng` or `gif`) to RGBA. */
export function decodeFramesWithFfmpeg(encoded: Buffer, demuxer: string, width: number, height: number): FfmpegFrames {
  const ffmpeg = getOracleToolPath('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg is required by this oracle test but is not installed (ORACLE_STRICT_MODE=1)');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-frames-'));
  try {
    const file = path.join(dir, `input.${demuxer}`);
    writeFileSync(file, encoded);
    const raw = execFileSync(
      ffmpeg,
      ['-v', 'error', '-f', demuxer, '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-fps_mode', 'passthrough', '-'],
      { maxBuffer: MAX_OUTPUT_BYTES }
    );
    const frameBytes = width * height * RGBA_CHANNELS;
    if (raw.length % frameBytes !== 0) {
      throw new Error(`ffmpeg produced ${raw.length} bytes, not a whole number of ${width}x${height} frames`);
    }
    const frames: Buffer[] = [];
    for (let at = 0; at < raw.length; at += frameBytes) frames.push(raw.subarray(at, at + frameBytes));
    return { width, height, frames };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
