import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
