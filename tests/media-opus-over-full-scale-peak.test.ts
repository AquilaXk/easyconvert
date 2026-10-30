import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { buildFfmpegArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { getOracleToolPath } from './helpers/differential-oracle';
import { measureLoudness } from './helpers/ffmpeg-measure';
import { oracleTest } from './helpers/oracle-test';
import { craftWav, int16Bytes } from './helpers/wav-craft';
import { openMediaInput } from '../src/lib/conversions/media-process';

/**
 * Opus from a source that sits at the rails. The encoded peak of such a source follows the exact samples the encoder is
 * given: the same signal resampled by two different filters decodes to true peaks up to 0.9 dB apart in both directions, at
 * the same bit rate. The benchmark row `true_peak_shift` allows 0.3 dB over the reference encode, so the encoder has to be
 * given what the reference command gives it. The oracles are the reference command (`ffmpeg -c:a libopus -b:a <rate>`),
 * driven directly, and the BS.1770 true-peak meter of ffmpeg's `ebur128`; neither is code of this project.
 */

const TEST_TIMEOUT_MS = 180_000;
const SAMPLE_RATE = 44_100;
const SECONDS = 4;
const BURST_PERIOD_S = 0.2;
const BURST_DECAY_PER_S = 45;
const NOISE_BLEND = 0.35;
const TONE_HZ = 1800;
const TONE_STEP_HZ = 150;
const FULL_SCALE = 32768;
const PCM_MAX = 32767;
/** The allowance of the benchmark row `true_peak_shift`: ours may exceed the reference by this much. */
const TRUE_PEAK_ALLOWANCE_DB = 0.3;

/** Bright decaying bursts (castanets-like transients) at a gain, hard-clipped to 16 bits. Deterministic: the noise is seeded. */
function burstSource(boostDb: number, seed: number): Uint8Array {
  let state = seed;
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const frames = SAMPLE_RATE * SECONDS;
  const gain = 10 ** (boostDb / 20);
  const period = Math.round(BURST_PERIOD_S * SAMPLE_RATE);
  const filtered = [0, 0];
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const envelope = Math.exp(-((i % period) / SAMPLE_RATE) * BURST_DECAY_PER_S);
    for (let channel = 0; channel < 2; channel++) {
      filtered[channel] = filtered[channel] * NOISE_BLEND + (random() * 2 - 1) * (1 - NOISE_BLEND);
      const tone = Math.sin((2 * Math.PI * (TONE_HZ + TONE_STEP_HZ * channel) * i) / SAMPLE_RATE);
      const value = (0.5 * filtered[channel] + 0.35 * tone) * envelope * gain;
      samples[i * 2 + channel] = Math.max(-FULL_SCALE, Math.min(PCM_MAX, Math.round(value * FULL_SCALE)));
    }
  }
  return craftWav({ sampleRate: SAMPLE_RATE, channels: 2, bitsPerSample: 16, data: int16Bytes(samples) });
}

/** Source levels and bit rates. The first three overshoot 0 dBTP; the last stays below it. In the first two, the lossy soxr resample used before the fix decoded 0.6 and 0.4 dB above the reference. */
const CASES = [
  { name: 'clipped by 18 dB, seed 2, 96 kbit/s', boostDb: 18, seed: 2, kbps: 96, overshoots: true },
  { name: 'clipped by 12 dB, seed 3, 64 kbit/s', boostDb: 12, seed: 3, kbps: 64, overshoots: true },
  { name: 'clipped by 18 dB, seed 3, 96 kbit/s', boostDb: 18, seed: 3, kbps: 96, overshoots: true },
  { name: 'a normal level (-12 dB), seed 1, 96 kbit/s', boostDb: -12, seed: 1, kbps: 96, overshoots: false },
] as const;

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-over-full-scale-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function tool(name: 'ffmpeg'): string {
  const found = getOracleToolPath(name);
  if (found === null) throw new Error(`${name} is not installed`);
  return found;
}

function run(args: string[]): void {
  execFileSync(tool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** MD5 of the decoded samples, as float so that nothing above full scale is clipped by the measurement. */
function decodedMd5(file: string): string {
  return execFileSync(tool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 'f32le', '-f', 'md5', '-'], { encoding: 'utf-8' }).trim();
}

function hasEncoder(name: string): boolean {
  return execFileSync(tool('ffmpeg'), ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).includes(name);
}

describe('Opus from a source at full scale is coded from the samples the reference command codes', () => {
  for (const { name, boostDb, seed, kbps, overshoots } of CASES) {
    oracleTest(
      `${name}: the decoded true peak is within the allowance of the reference and the decoded samples are the same`,
      ['ffmpeg'],
      () => {
        if (!hasEncoder('libopus')) throw Object.assign(new Error('this ffmpeg has no libopus encoder'), { isOracleSkip: true });
        const input = path.join(workDir, `src-${boostDb}-${seed}.wav`);
        fs.writeFileSync(input, burstSource(boostDb, seed));
        // The test is about sources that overshoot, so the source itself is measured, not assumed.
        const sourcePeak = measureLoudness(tool('ffmpeg'), input).truePeak;
        if (overshoots) expect(sourcePeak).toBeGreaterThan(0);
        else expect(sourcePeak).toBeLessThan(-1);

        const ours = path.join(workDir, `ours-${boostDb}-${seed}.opus`);
        run(buildFfmpegArguments(openMediaInput(input, 'wav'), ours, 'opus', { audio: { bitrateK: kbps } }, tool('ffmpeg')));
        const reference = path.join(workDir, `ref-${boostDb}-${seed}.opus`);
        run(['-y', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', `${kbps}k`, reference]);

        const oursPeak = measureLoudness(tool('ffmpeg'), ours).truePeak;
        const referencePeak = measureLoudness(tool('ffmpeg'), reference).truePeak;
        expect(oursPeak - sourcePeak).toBeLessThanOrEqual(referencePeak - sourcePeak + TRUE_PEAK_ALLOWANCE_DB);
        expect(decodedMd5(ours)).toBe(decodedMd5(reference));
      },
      TEST_TIMEOUT_MS
    );
  }
});
