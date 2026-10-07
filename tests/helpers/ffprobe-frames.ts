import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/** ffprobe oracle for the number of decoded frames of an animated image. */

export const HAS_FFPROBE = getOracleToolPath('ffprobe') !== null;
export const SKIP_WITHOUT_FFPROBE = !HAS_FFPROBE && process.env.ORACLE_STRICT_MODE !== '1';

/** Counts the frames ffprobe decodes from the first video stream of `encoded` (`extension` names the container). */
export function ffprobeFrameCount(encoded: Buffer, extension: string): number {
  const ffprobe = getOracleToolPath('ffprobe');
  if (!ffprobe) throw new Error('ffprobe is required by this oracle test but is not installed (ORACLE_STRICT_MODE=1)');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffprobe-oracle-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    writeFileSync(file, encoded);
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file],
      { encoding: 'utf8' }
    );
    return Number(out.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
