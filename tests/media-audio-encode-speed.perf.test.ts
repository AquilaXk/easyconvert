import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';

/**
 * Timing-ratio checks for the audio encodes. A job through the dispatcher may take at most the share of the time of the
 * reference encoder run directly on the same file that the parity gate allows (3 percent). They compare runs of the
 * same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate. What the job does besides the
 * encoder (which processes it starts, which flags it gives the reader) is asserted in media-audio-encode-overhead.test.ts.
 */

// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratio on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;
const PARITY_TOLERANCE = 0.03;
const MAX_JOB_VS_REFERENCE = 1 + PARITY_TOLERANCE;
const TIMING_PASSES = 7;
const BITRATE_K = 64;
const TONE_HZ = 440;
const TONE_AMPLITUDE = 12_000;

const CASES = [
  { name: '4 s of 44.1 kHz stereo to opus', rate: 44_100, channels: 2, seconds: 4, target: 'opus', encoder: ['-c:a', 'libopus'] },
  { name: '4 s of 44.1 kHz stereo to aac', rate: 44_100, channels: 2, seconds: 4, target: 'aac', encoder: ['-c:a', 'aac', '-f', 'adts'] },
  { name: '8 s of 16 kHz mono to opus', rate: 16_000, channels: 1, seconds: 8, target: 'opus', encoder: ['-c:a', 'libopus'] },
  { name: '8 s of 16 kHz mono to aac', rate: 16_000, channels: 1, seconds: 8, target: 'aac', encoder: ['-c:a', 'aac', '-f', 'adts'] },
] as const;

describe.skipIf(SKIP_TIMING)('audio encode job time against the reference encoder', () => {
  for (const item of CASES) {
    oracleTest(
      `${item.name} takes no more than 1.03x the time of ffmpeg run directly`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        const ffmpeg = getOracleToolPath('ffmpeg')!;
        const frames = item.rate * item.seconds;
        const wav = craftWav({
          sampleRate: item.rate,
          channels: item.channels,
          bitsPerSample: 16,
          data: int16Bytes(sineSamples(frames, item.channels, item.rate, TONE_HZ, TONE_AMPLITUDE)),
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-encode-speed-'));
        try {
          const input = path.join(dir, 'in.wav');
          const output = path.join(dir, `ref.${item.target}`);
          fs.writeFileSync(input, wav);
          const measurement = await expectNoSlowerThanReference(
            item.name,
            () =>
              execFileSync(
                ffmpeg,
                ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', input, '-vn', '-map_metadata', '-1', ...item.encoder, '-b:a', `${BITRATE_K}k`, output],
                { stdio: 'ignore' }
              ),
            () => dispatchConversion(Buffer.from(wav), 'wav', item.target, { audio: { codec: item.target, bitrateK: BITRATE_K } }, 'in.wav'),
            { maxRatio: MAX_JOB_VS_REFERENCE, passes: TIMING_PASSES }
          );
          const encoded = (measurement.largeResult as { buffer: Buffer }).buffer;
          const magic = item.target === 'opus' ? encoded.subarray(0, 4).toString('latin1') : encoded.subarray(0, 2).toString('hex');
          expect(magic).toBe(item.target === 'opus' ? 'OggS' : 'fff1');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS
    );
  }
});
