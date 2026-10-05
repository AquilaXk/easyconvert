import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath, isOracleToolAvailable } from './differential-oracle';

/** Decodes OpenEXR output with the standard FFmpeg `exr` decoder, an oracle independent of the engine. */

export const HAS_FFMPEG_EXR = isOracleToolAvailable('ffmpeg') && isOracleToolAvailable('ffprobe');

const FLOAT_BYTES = 4;
const PLANES = 3;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

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

/** Decodes to planar float (FFmpeg orders the planes G, B, R) and interleaves them as R,G,B. */
export function decodeExrWithFfmpeg(buffer: Buffer): DecodedExr {
  const info = probeExr(buffer);
  const raw = withTempFile(buffer, 'exr', (file) =>
    execFileSync(
      toolPath('ffmpeg'),
      ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-'],
      { maxBuffer: MAX_OUTPUT_BYTES }
    )
  );
  const pixels = info.width * info.height;
  if (raw.length !== pixels * PLANES * FLOAT_BYTES) {
    throw new Error(`ffmpeg produced ${raw.length} bytes, expected ${pixels * PLANES * FLOAT_BYTES}`);
  }
  const plane = (index: number) =>
    new Float32Array(raw.buffer.slice(raw.byteOffset + index * pixels * FLOAT_BYTES, raw.byteOffset + (index + 1) * pixels * FLOAT_BYTES));
  const [g, b, r] = [plane(0), plane(1), plane(2)];
  const rgb = new Float32Array(pixels * PLANES);
  for (let i = 0; i < pixels; i++) {
    rgb[i * PLANES] = r[i];
    rgb[i * PLANES + 1] = g[i];
    rgb[i * PLANES + 2] = b[i];
  }
  return { ...info, rgb };
}
