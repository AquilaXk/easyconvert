import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { bdRate, type RdPoint } from '../bench/bd-rate';
import { fileSize, measureAudioSnr, probeFile } from '../bench/measure';
import { convertMedia } from '../src/lib/conversions/media';
import { buildFfmpegArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Opus quality against libopus driven directly by ffmpeg. The oracle is the reference encoder itself plus ffmpeg's
 * `asdr` filter (the benchmark's SNR measurement); nothing here is read from the code under test. The reference
 * gives libopus the source's own rate, so any bit-rate-quality gap is the project forcing something else on it.
 */

const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');
const FFMPEG_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 300_000;
const TONE_HZ = 440;
const TONE_SECONDS = 0.5;
const BITS_PER_BYTE = 8;
const BITS_PER_KILOBIT = 1000;
/** Source rate -> rate the Opus encoder is expected to be fed, written by hand from the Opus rate set (8, 12, 16, 24, 48 kHz). */
const EXPECTED_ENCODE_RATE: ReadonlyArray<readonly [number, number | undefined]> = [
  [8000, undefined],
  [11025, 12000],
  [16000, undefined],
  [22050, 24000],
  [24000, undefined],
  [32000, 48000],
  [44100, 48000],
  [48000, undefined],
  [96000, 48000],
];
/** The speech clip's four rates and the allowed BD-rate (percent) against the reference. */
const SPEECH_KBPS = [16, 24, 32, 48] as const;
const MUSIC_KBPS = [48, 64, 96, 128] as const;
const MAX_BD_RATE_PERCENT = 5;
/** Per-point SNR tolerance (dB) and size tolerance against the reference. */
const SNR_TOLERANCE_DB = 0.5;
const SIZE_TOLERANCE = 0.05;

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-opus-rate-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  execFileSync(getOracleToolPath('ffmpeg')!, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FFMPEG_TIMEOUT_MS,
  });
}

function toneAtRate(rate: number): string {
  const file = path.join(workDir, `tone-${rate}.wav`);
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=${rate}:duration=${TONE_SECONDS}`, '-ac', '1', file]);
  return file;
}

function argAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('the Opus encoder is fed the source rate when it can code it', () => {
  oracleTest('keeps a supported rate and resamples only to the lowest rate that covers the band', ['ffmpeg', 'ffprobe'], () => {
    for (const [rate, expected] of EXPECTED_ENCODE_RATE) {
      const args = buildFfmpegArguments(toneAtRate(rate), path.join(workDir, 'o.opus'), 'wav', 'opus', {}, getOracleToolPath('ffmpeg'));
      expect(argAfter(args, '-ar'), `-ar for a ${rate} Hz input`).toBe(expected === undefined ? undefined : String(expected));
      if (expected === undefined) {
        expect(argAfter(args, '-filter:a'), `no resample filter for a ${rate} Hz input`).toBeUndefined();
      }
    }
  });

  oracleTest('keeps the 48 kHz fallback when the input cannot be probed', ['ffmpeg'], () => {
    const args = buildFfmpegArguments('/nonexistent/in.wav', path.join(workDir, 'o.opus'), 'wav', 'opus', {});
    expect(argAfter(args, '-ar')).toBe('48000');
  });
});

interface Point extends RdPoint {
  snr: number;
}

async function oursPoint(sourceFile: string, kbps: number): Promise<Point> {
  const out = path.join(workDir, `ours-${path.basename(sourceFile)}-${kbps}.opus`);
  const converted = await convertMedia(fs.readFileSync(sourceFile), 'wav', 'opus', { audio: { codec: 'opus', bitrateK: kbps } }, path.basename(sourceFile));
  fs.writeFileSync(out, converted.buffer);
  return measurePoint(out, sourceFile);
}

function referencePoint(sourceFile: string, kbps: number): Point {
  const out = path.join(workDir, `ref-${path.basename(sourceFile)}-${kbps}.opus`);
  ffmpeg(['-i', sourceFile, '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', `${kbps}k`, out]);
  return measurePoint(out, sourceFile);
}

function measurePoint(file: string, sourceFile: string): Point {
  const ffmpegBin = getOracleToolPath('ffmpeg')!;
  const ffprobeBin = getOracleToolPath('ffprobe')!;
  const source = probeFile(ffprobeBin, sourceFile).streams[0];
  const seconds = Number(probeFile(ffprobeBin, file).format.duration);
  const snr = measureAudioSnr(ffmpegBin, file, sourceFile, Number(source.sample_rate), source.channels ?? 1);
  return { rate: (fileSize(file) * BITS_PER_BYTE) / seconds / BITS_PER_KILOBIT, quality: snr, snr };
}

describe('Opus rate-quality against libopus fed the source directly', () => {
  for (const [name, file, rates] of [
    ['speech', 'speech.wav', SPEECH_KBPS],
    ['music', 'music.wav', MUSIC_KBPS],
  ] as const) {
    oracleTest(`${name}: BD-rate over SNR is within ${MAX_BD_RATE_PERCENT}% and no point is worse than the reference`, ['ffmpeg', 'ffprobe'], async () => {
      const source = path.join(CORPUS, file);
      const ours: Point[] = [];
      const reference: Point[] = [];
      for (const kbps of rates) {
        ours.push(await oursPoint(source, kbps));
        reference.push(referencePoint(source, kbps));
      }
      for (let i = 0; i < rates.length; i++) {
        expect(ours[i].snr, `${name} ${rates[i]}k SNR`).toBeGreaterThanOrEqual(reference[i].snr - SNR_TOLERANCE_DB);
        expect(ours[i].rate, `${name} ${rates[i]}k bit rate`).toBeLessThanOrEqual(reference[i].rate * (1 + SIZE_TOLERANCE));
      }
      expect(bdRate(reference, ours)).toBeLessThanOrEqual(MAX_BD_RATE_PERCENT);
    }, TEST_TIMEOUT_MS);
  }
});
