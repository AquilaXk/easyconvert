import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { buildAnimatedWebpFromStill } from './helpers/webp-builder';
import { SeededRandom } from './helpers/archive-corpus';
import { buildTiffWithOrientation } from './helpers/exif-orientation';
import { SERVICE_MALLOC_ARENA_MAX } from './helpers/service-heap';

/**
 * Peak-memory regression for oriented animations: each conversion runs in a fresh Node process and the
 * kernel's resident high-water mark (VmHWM) before and after it is compared with the 512 MiB budget plus a
 * 64 MiB margin. An animation the budget admits must stay under that; one it refuses must not have been
 * decoded at all. The child runs with the service's glibc heap bound (SERVICE_MALLOC_ARENA_MAX, read from docker-compose.yml): without
 * it the child grows an arena for each thread of the image library and reads a figure the service never reaches (policy entry 112).
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
const ADMITTED_SIDE = 2000;
const ADMITTED_FRAMES = 6;
const NOISE_SEED = 7;
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
  const raw = new SeededRandom(NOISE_SEED).bytes(side * side * 3);
  const still = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).webp({ quality: NOISE_QUALITY }).toBuffer();
  const file = path.join(dir, `noise_${side}_${frames}.webp`);
  fs.writeFileSync(
    file,
    buildAnimatedWebpFromStill(still, { width: side, height: side, frames, exif: buildTiffWithOrientation(ROTATED_QUARTER_TURN) })
  );
  return file;
}

async function measure(file: string, sourceFormat: string, target: string): Promise<Measurement> {
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', MEASURE_SCRIPT, file, target, '{}', sourceFormat], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MALLOC_ARENA_MAX: SERVICE_MALLOC_ARENA_MAX },
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
  it.skipIf(SKIP).each(['webp', 'gif'])(
    'an admitted worst case (2000x2000 x 6 noisy frames to %s) stays within budget plus margin',
    async (target) => {
      const result = await measure(await noisyAnimation(ADMITTED_SIDE, ADMITTED_FRAMES), 'webp', target);
      expect(result.status).toBe('converted');
      expect(result.addedMiB).toBeLessThan(BUDGET_MIB + MARGIN_MIB);
    },
    TEST_TIMEOUT_MS + FIXTURE_TIMEOUT_MS
  );

  it.skipIf(SKIP).each([
    ['2000x2000 x 7 frames', 2000, 7],
    ['2000x2000 x 14 frames', 2000, 14],
    ['3000x3000 x 5 frames', 3000, 5],
  ])(
    '%s is refused before it can exceed budget plus margin',
    async (_label, side, frames) => {
      const result = await measure(await noisyAnimation(side, frames), 'webp', 'gif');
      expect(result.status).toMatch(/^refused: .* over the 512 MiB decoded animation limit$/);
      expect(result.addedMiB).toBeLessThan(BUDGET_MIB + MARGIN_MIB);
    },
    TEST_TIMEOUT_MS
  );
});
