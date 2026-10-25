import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath, isOracleToolAvailable } from './differential-oracle';
import { halfBitsToFloat } from './openexr-writer';

/** Decodes OpenEXR output with the standard FFmpeg `exr` decoder, an oracle independent of the engine. */

export const HAS_FFMPEG_EXR = isOracleToolAvailable('ffmpeg') && isOracleToolAvailable('ffprobe');

const FLOAT_BYTES = 4;
const HALF_BYTES = 2;
const PLANES = 3;
const FLOAT_PIX_FMT = 'gbrpf32le';
const HALF_PIX_FMT = 'gbrpf16le';
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * The pixel formats ffprobe may name for a half-float OpenEXR file: gbrpf32le from FFmpeg before 8.0, which widens the samples, and
 * gbrpf16le from 8.0, which keeps them.
 */
export const HALF_EXR_PIX_FMTS: readonly string[] = [FLOAT_PIX_FMT, HALF_PIX_FMT];

export interface ExrProbe {
  codec: string;
  width: number;
  height: number;
  pixFmt: string;
}

export interface DecodedExr extends ExrProbe {
  /** Interleaved linear R,G,B float samples (width * height * 3). */
  rgb: Float32Array;
}

function withTempFile<T>(buffer: Buffer, extension: string, run: (file: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exr-oracle-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    writeFileSync(file, buffer);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function toolPath(tool: 'ffmpeg' | 'ffprobe'): string {
  const resolved = getOracleToolPath(tool);
  if (!resolved) throw new Error(`${tool} is not installed`);
  return resolved;
}

/** Probes the first video stream of a still image file with ffprobe. */
export function probeStill(buffer: Buffer, extension: string): ExrProbe {
  return withTempFile(buffer, extension, (file) => {
    const out = execFileSync(
      toolPath('ffprobe'),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', file],
      { encoding: 'utf8' }
    );
    const stream = (JSON.parse(out) as { streams: { codec_name: string; width: number; height: number; pix_fmt: string }[] })
      .streams[0];
    if (!stream) throw new Error('ffprobe found no video stream in the probed file');
    return { codec: stream.codec_name, width: stream.width, height: stream.height, pixFmt: stream.pix_fmt };
  });
}

export function probeExr(buffer: Buffer): ExrProbe {
  return probeStill(buffer, 'exr');
}

/**
 * Decodes to planar samples in the file's own pixel format (FFmpeg orders the planes G, B, R) and interleaves them as R,G,B. A half
 * float file is read as half floats, so no conversion in FFmpeg stands between the file and the values compared.
 */
export function decodeExrWithFfmpeg(buffer: Buffer): DecodedExr {
  const info = probeExr(buffer);
  const half = info.pixFmt === HALF_PIX_FMT;
  const sampleBytes = half ? HALF_BYTES : FLOAT_BYTES;
  const raw = withTempFile(buffer, 'exr', (file) =>
    execFileSync(
      toolPath('ffmpeg'),
      ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', half ? HALF_PIX_FMT : FLOAT_PIX_FMT, '-'],
      { maxBuffer: MAX_OUTPUT_BYTES }
    )
  );
  const pixels = info.width * info.height;
  if (raw.length !== pixels * PLANES * sampleBytes) {
    throw new Error(`ffmpeg produced ${raw.length} bytes, expected ${pixels * PLANES * sampleBytes}`);
  }
  const plane = (index: number): Float32Array => {
    const start = raw.byteOffset + index * pixels * sampleBytes;
    if (!half) return new Float32Array(raw.buffer.slice(start, start + pixels * sampleBytes));
    const bits = new Uint16Array(raw.buffer.slice(start, start + pixels * sampleBytes));
    return Float32Array.from(bits, halfBitsToFloat);
  };
  const [g, b, r] = [plane(0), plane(1), plane(2)];
  const rgb = new Float32Array(pixels * PLANES);
  for (let i = 0; i < pixels; i++) {
    rgb[i * PLANES] = r[i];
    rgb[i * PLANES + 1] = g[i];
    rgb[i * PLANES + 2] = b[i];
  }
  return { ...info, rgb };
}
