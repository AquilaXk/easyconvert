import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath, OracleToolMissingError } from './differential-oracle';

/**
 * Reference-authored media fixtures: ffmpeg encodes synthetic lavfi sources into real files, so the demuxers and
 * muxers under test are judged on bytes that no engine of this project wrote.
 */

const MAX_FFMPEG_OUTPUT_BYTES = 64 * 1024 * 1024;

function requireFfmpeg(): string {
  const found = getOracleToolPath('ffmpeg');
  if (!found) throw new OracleToolMissingError('ffmpeg');
  return found;
}

const encoderCache = new Map<string, boolean>();

/** Throws OracleToolMissingError (a skip locally, a failure under ORACLE_STRICT_MODE=1) when ffmpeg lacks an encoder. */
export function requireEncoders(...names: string[]): void {
  const ffmpeg = requireFfmpeg();
  for (const name of names) {
    let present = encoderCache.get(name);
    if (present === undefined) {
      const listing = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
      present = new RegExp(`^\\s[A-Z.]{6}\\s${name}\\s`, 'm').test(listing);
      encoderCache.set(name, present);
    }
    if (!present) throw new OracleToolMissingError(`ffmpeg encoder ${name}`);
  }
}

/** Runs ffmpeg with `args` (inputs and codecs) and returns the bytes it wrote to a file with `extension`. */
export function runFfmpeg(args: string[], extension: string): Buffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-fixture-'));
  try {
    const out = path.join(dir, `out.${extension}`);
    execFileSync(requireFfmpeg(), ['-v', 'error', '-y', ...args, out], { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES });
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface VideoSourceSpec {
  width: number;
  height: number;
  fps: number;
  seconds: number;
}

/** lavfi test pattern input arguments. */
export function testPatternInput(spec: VideoSourceSpec): string[] {
  return ['-f', 'lavfi', '-i', `testsrc=size=${spec.width}x${spec.height}:rate=${spec.fps}:duration=${spec.seconds}`];
}

/** lavfi sine input arguments (mono; pass `-ac 2` among the output arguments for stereo). */
export function sineInput(sampleRate: number, seconds: number): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sampleRate}:duration=${seconds}`];
}

const H264_ARGS = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2', '-g', '12'];

/** 2 s of 320x240 25 fps H.264 with B-frames and 44.1 kHz mono AAC-LC; `extra` are output arguments. */
export function h264AacMp4(extra: string[] = []): Buffer {
  requireEncoders('libx264', 'aac');
  return runFfmpeg(
    [
      ...testPatternInput({ width: 320, height: 240, fps: 25, seconds: 2 }),
      ...sineInput(44100, 2),
      ...H264_ARGS,
      '-c:a', 'aac', '-shortest',
      ...extra,
    ],
    'mp4'
  );
}

/** ISO/IEC 14496-3 sampling_frequency_index order. */
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The two-byte AudioSpecificConfig of AAC-LC, built from the stream facts the reference probe reports. */
export function aacLcSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const index = AAC_RATES.indexOf(sampleRate);
  if (index < 0) throw new Error(`no AAC sampling frequency index for ${sampleRate} Hz`);
  const AAC_LC = 2;
  const bits = (AAC_LC << 11) | (index << 7) | (channels << 3);
  return Uint8Array.from([bits >> 8, bits & 0xff]);
}

/** Writes `bytes` to a temporary file with `extension`, runs `run(path)` and removes the file. */
function withFile<T>(bytes: Uint8Array, extension: string, run: (file: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-input-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    writeFileSync(file, bytes);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What the reference decoder says when it decodes every stream of `bytes` to nothing: empty when the file is
 * a clean, decodable stream, the error log otherwise.
 */
export function ffmpegDecodeErrors(bytes: Uint8Array, extension: string): string {
  return withFile(bytes, extension, (file) => {
    const result = spawnSync(requireFfmpeg(), ['-v', 'error', '-i', file, '-f', 'null', '-'], {
      encoding: 'utf8',
      maxBuffer: MAX_FFMPEG_OUTPUT_BYTES,
    });
    return `${result.status === 0 ? '' : `exit ${result.status}: `}${result.stderr}`.trim();
  });
}

/** The reference decoder's md5 of every decoded frame of the first video stream. */
export function ffmpegVideoFrameHashes(bytes: Uint8Array, extension: string): string[] {
  return withFile(bytes, extension, (file) => {
    const out = execFileSync(requireFfmpeg(), ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], {
      encoding: 'utf8',
      maxBuffer: MAX_FFMPEG_OUTPUT_BYTES,
    });
    return out
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split(',').pop()?.trim() ?? '');
  });
}

/** Bytes of 16-bit PCM the reference decoder outputs for the first audio stream (every decoded sample, after trimming). */
export function ffmpegDecodedAudioBytes(bytes: Uint8Array, extension: string): number {
  return withFile(bytes, extension, (file) =>
    execFileSync(requireFfmpeg(), ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-'], {
      maxBuffer: MAX_FFMPEG_OUTPUT_BYTES,
    }).byteLength
  );
}
