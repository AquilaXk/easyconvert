import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { buildAnimatedWebpFromStill } from './helpers/webp-builder';
import { buildTiffWithOrientation } from './helpers/exif-orientation';

/**
 * Peak-memory regression for oriented animations: each conversion runs in a fresh Node process and the
 * kernel's resident high-water mark (VmHWM) before and after it is compared with the 512 MiB budget plus a
 * 64 MiB margin. An animation the budget admits must stay under that; one it refuses must not have been
 * decoded at all. The measured peaks of the cases that used to be admitted were 617 MiB (2000x2000 x 14
 * frames) and 685 MiB (3000x3000 x 5 frames).
 *
 * Oracle: /proc/self/status of the child process, independent of the converter's own accounting. The fixtures
 * are animated WebP files built by the hand-written container builder around one noisy still image per size,
 * with EXIF orientation 6 so the frame-by-frame orienting path runs.
 */

const execFileAsync = promisify(execFile);
const BUDGET_MIB = 512;
const MARGIN_MIB = 64;
const NOISE_QUALITY = 90;
const ROTATED_QUARTER_TURN = 6;
const CHILD_TIMEOUT_MS = 170_000;
const TEST_TIMEOUT_MS = 180_000;
const FIXTURE_TIMEOUT_MS = 60_000;
const HAS_PROC = fs.existsSync('/proc/self/status');
const SKIP = !HAS_PROC && process.env.ORACLE_STRICT_MODE !== '1';
const MEASURE_SCRIPT = path.join(__dirname, 'helpers', 'measure-peak-conversion.mts');

interface Measurement {
  status: string;
  baselineMiB: number;
  peakMiB: number;
  addedMiB: number;
  outputBytes: number;
}

let dir: string;

async function noisyAnimation(side: number, frames: number): Promise<string> {
  const raw = crypto.randomBytes(side * side * 3);
  const still = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).webp({ quality: NOISE_QUALITY }).toBuffer();
  const file = path.join(dir, `noise_${side}_${frames}.webp`);
  fs.writeFileSync(
    file,
    buildAnimatedWebpFromStill(still, { width: side, height: side, frames, exif: buildTiffWithOrientation(ROTATED_QUARTER_TURN) })
  );
  return file;
}

async function measure(file: string, target: string): Promise<Measurement> {
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', MEASURE_SCRIPT, file, target, '{}', 'webp'], {
    cwd: path.join(__dirname, '..', '..'),
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split('\n').pop() as string) as Measurement;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-memory-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('peak memory of oriented animations', () => {
  it.skipIf(SKIP)(
    'an admitted worst case (2000x2000 x 10 noisy frames to webp) stays within budget plus margin',
    async () => {
      const result = await measure(await noisyAnimation(2000, 10), 'webp');
      expect(result.status).toBe('converted');
      expect(result.addedMiB).toBeLessThan(BUDGET_MIB + MARGIN_MIB);
    },
    TEST_TIMEOUT_MS + FIXTURE_TIMEOUT_MS
  );

  it.skipIf(SKIP).each([
    ['2000x2000 x 14 frames', 2000, 14],
    ['3000x3000 x 5 frames', 3000, 5],
  ])(
    '%s is refused before it can exceed budget plus margin',
    async (_label, side, frames) => {
      const result = await measure(await noisyAnimation(side, frames), 'gif');
      expect(result.status).toMatch(/^refused: .* over the 512 MiB decoded animation limit$/);
      expect(result.addedMiB).toBeLessThan(BUDGET_MIB + MARGIN_MIB);
    },
    TEST_TIMEOUT_MS
  );
});
