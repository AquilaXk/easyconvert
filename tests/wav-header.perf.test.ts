import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of wav-header.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratio on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 120_000;
/** The job may take this many times what ffmpeg takes when run directly on the same file (speed ratio of 0.8). */
const MAX_JOB_VS_FFMPEG = 1.25;

function pcm16(frames: number, channels: number, rate: number): Uint8Array {
  return int16Bytes(sineSamples(frames, channels, rate, 440, 12000));
}

describe.skipIf(SKIP_TIMING)('wav to flac job time', () => {
  oracleTest(
    'takes no more than 1.25x the time of ffmpeg run directly on the same file',
    ['ffmpeg', 'ffprobe', 'unshare'],
    async () => {
      const ffmpeg = getOracleToolPath('ffmpeg')!;
      const wav = craftWav({ sampleRate: 44_100, channels: 1, bitsPerSample: 16, data: pcm16(44_100 * 8, 1, 44_100) });
      const dir = mkdtempSync(join(tmpdir(), 'wav-flac-'));
      try {
        const input = join(dir, 'in.wav');
        const output = join(dir, 'ref.flac');
        writeFileSync(input, wav);
        const measurement = await expectNoSlowerThanReference(
          'wav to flac',
          () => execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', '5', output]),
          () => dispatchConversion(Buffer.from(wav), 'wav', 'flac', {}, 'in.wav'),
          { maxRatio: MAX_JOB_VS_FFMPEG, passes: 5 }
        );
        const flac = (measurement.largeResult as { buffer: Buffer }).buffer;
        expect(flac.subarray(0, 4).toString('latin1')).toBe('fLaC');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
