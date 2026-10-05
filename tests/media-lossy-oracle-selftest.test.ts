import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  bestSnrDb,
  chirpSamples,
  decodeAudioWithFfmpeg,
  sineSamples,
  wavFromSamples,
} from './helpers/media-lossy-oracle';

/**
 * Self-tests for the lossy round-trip oracle: it must accept a genuine reference-encoder round
 * trip and reject the fakes a faulty encoder could produce (an unrelated synthesized tone, a
 * truncated stream, a duplicated or silent channel).
 */

const SAMPLE_RATE = 44100;
const SECONDS = 1;
const CHANNELS = 2;
const MIN_ROUNDTRIP_SNR_DB = 25;
/** An unrelated signal correlates with the source at roughly 0 dB; anything below this is a reject. */
const MAX_FAKE_SNR_DB = 6;
const TRUNCATED_FRACTION = 3;
const SHIFT_FRAMES = 100;
const MIN_CHIRP_LAG_DIFFERENCE = 1000;
const MAX_EQUAL_CHANNEL_FRACTION = 0.01;
const FFMPEG_TEST_TIMEOUT_MS = 60_000;

function channelOf(samples: Int16Array, channel: number): Int16Array {
  const out = new Int16Array(samples.length / CHANNELS);
  for (let i = 0; i < out.length; i++) out[i] = samples[i * CHANNELS + channel];
  return out;
}

function truncateToThird(samples: Int16Array): Int16Array {
  const frames = Math.floor(samples.length / CHANNELS / TRUNCATED_FRACTION);
  return samples.slice(0, frames * CHANNELS);
}

function duplicateChannel0(samples: Int16Array): Int16Array {
  const out = Int16Array.from(samples);
  for (let i = 0; i < out.length; i += CHANNELS) out[i + 1] = out[i];
  return out;
}

describe('chirp source is non-periodic and per-channel distinct', () => {
  const source = chirpSamples(SAMPLE_RATE, CHANNELS, SECONDS);

  it('differs between channels', () => {
    const left = channelOf(source, 0);
    const right = channelOf(source, 1);
    let equal = 0;
    for (let i = 0; i < left.length; i++) if (left[i] === right[i]) equal++;
    expect(equal / left.length).toBeLessThan(MAX_EQUAL_CHANNEL_FRACTION);
  });

  it('does not repeat at any plausible codec-delay lag', () => {
    const left = channelOf(source, 0);
    for (const lag of [100, 441, 882, 1024, 2048]) {
      let diff = 0;
      for (let i = 0; i + lag < left.length; i++) diff += Math.abs(left[i] - left[i + lag]);
      expect(diff / (left.length - lag)).toBeGreaterThan(MIN_CHIRP_LAG_DIFFERENCE);
    }
  });
});

describe('bestSnrDb accepts faithful decodes', () => {
  const source = chirpSamples(SAMPLE_RATE, CHANNELS, SECONDS);

  it('scores an identical decode as infinite', () => {
    expect(bestSnrDb(source, source, CHANNELS)).toBe(Infinity);
  });

  it('scores a decode delayed by whole frames as infinite', () => {
    const delayed = new Int16Array(source.length + SHIFT_FRAMES * CHANNELS);
    delayed.set(source, SHIFT_FRAMES * CHANNELS);
    expect(bestSnrDb(source, delayed, CHANNELS)).toBe(Infinity);
  });
});

describe('bestSnrDb rejects unfaithful decodes', () => {
  const source = chirpSamples(SAMPLE_RATE, CHANNELS, SECONDS);

  it('rejects an independently synthesized tone of the same length', () => {
    const tone = sineSamples(SAMPLE_RATE, CHANNELS, SECONDS);
    expect(tone.length).toBe(source.length);
    expect(bestSnrDb(source, tone, CHANNELS)).toBeLessThan(MAX_FAKE_SNR_DB);
  });

  it('rejects a stream truncated to one third of the source', () => {
    expect(bestSnrDb(source, truncateToThird(source), CHANNELS)).toBe(-Infinity);
  });

  it('rejects channel 1 replaced by a copy of channel 0', () => {
    expect(bestSnrDb(source, duplicateChannel0(source), CHANNELS)).toBeLessThan(MAX_FAKE_SNR_DB);
  });

  it('rejects a silent channel 1', () => {
    const silent = Int16Array.from(source);
    for (let i = 1; i < silent.length; i += CHANNELS) silent[i] = 0;
    expect(bestSnrDb(source, silent, CHANNELS)).toBeLessThan(MAX_FAKE_SNR_DB);
  });
});

describe('bestSnrDb against the reference encoder', () => {
  oracleTest(
    'accepts a genuine FFmpeg AAC round trip and rejects its truncation and channel duplication',
    ['ffmpeg'],
    () => {
      const source = chirpSamples(SAMPLE_RATE, CHANNELS, SECONDS);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-oracle-self-'));
      try {
        const wavPath = path.join(dir, 'in.wav');
        const aacPath = path.join(dir, 'out.m4a');
        fs.writeFileSync(wavPath, wavFromSamples(source, SAMPLE_RATE, CHANNELS));
        execFileSync(getOracleToolPath('ffmpeg') as string, ['-v', 'error', '-y', '-i', wavPath, '-c:a', 'aac', aacPath]);
        const decoded = decodeAudioWithFfmpeg(fs.readFileSync(aacPath), 'm4a', SAMPLE_RATE, CHANNELS);

        expect(bestSnrDb(source, decoded, CHANNELS)).toBeGreaterThanOrEqual(MIN_ROUNDTRIP_SNR_DB);
        expect(bestSnrDb(source, truncateToThird(decoded), CHANNELS)).toBe(-Infinity);
        expect(bestSnrDb(source, duplicateChannel0(decoded), CHANNELS)).toBeLessThan(MAX_FAKE_SNR_DB);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    FFMPEG_TEST_TIMEOUT_MS
  );
});

it('sizes the chirp to the requested duration', () => {
  expect(chirpSamples(SAMPLE_RATE, 1, SECONDS).length).toBe(SAMPLE_RATE * SECONDS);
});
