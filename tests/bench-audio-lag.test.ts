import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect } from 'vitest';
import { measureAudioSnr } from '../bench/measure';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The benchmark scores a lossy audio encode by its signal-to-noise ratio against the source, after the two are
 * aligned. A raw ADTS stream carries no priming, so the decoder writes the encoder's own delay in front of the music
 * and the alignment has to remove exactly that. FFmpeg 9's AAC encode of `music.wav` at 64 kbit/s made the old
 * alignment (the strongest unnormalised cross-correlation over +-4,096 samples) pick lag 351, one period of the
 * 65 Hz bass line, instead of 1,024, so the SNR read 2.96 dB where the aligned figure is above 13 dB (#783, #891).
 *
 * The oracle does not use the benchmark's code. The same encoder writes the same packets into an MP4 file, whose
 * edit list tells the decoder to skip the priming (`initial_padding`, libavcodec/aacenc.c line 1165 of n9.0.2); the
 * decoded samples of the two files are equal once the ADTS decode is moved by the delay, which this test finds by exact
 * comparison, and the SNR is summed here from the aligned samples.
 */

const ffmpeg = getOracleToolPath('ffmpeg');
const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');
const MUSIC = path.join(CORPUS, 'music.wav');
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const SEARCH_SAMPLES = 4_096;
const SNR_TOLERANCE_DB = 0.05;
/** The delay libavcodec/aacenc.c states: `avctx->initial_padding = 1024`. */
const AAC_PRIMING_SAMPLES = 1_024;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-audio-lag-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

function run(args: string[]): Buffer {
  return execFileSync(ffmpeg as string, ['-hide_banner', '-nostdin', '-v', 'error', ...args], { maxBuffer: 1 << 28 });
}

function encode(kbps: number, extension: 'aac' | 'm4a'): string {
  const file = path.join(workDir, `music-${kbps}.${extension}`);
  run(['-y', '-i', MUSIC, '-vn', '-map_metadata', '-1', '-c:a', 'aac', ...(extension === 'aac' ? ['-f', 'adts'] : []), '-b:a', `${kbps}k`, file]);
  return file;
}

function samples(file: string): Int16Array {
  const pcm = run(['-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-']);
  return new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % BYTES_PER_SAMPLE)));
}

/** The shift at which the ADTS decode equals the MP4 decode, found by exact comparison of 32,768 samples. */
function exactShift(adts: Int16Array, mp4: Int16Array): number {
  const compared = 32_768 * CHANNELS;
  const from = 8_192 * CHANNELS;
  for (let shift = 0; shift <= SEARCH_SAMPLES; shift++) {
    let equal = true;
    for (let i = from; i < from + compared; i++) {
      if (adts[i + shift * CHANNELS] !== mp4[i]) {
        equal = false;
        break;
      }
    }
    if (equal) return shift;
  }
  return -1;
}

/**
 * The mean over the channels of 10 log10 of signal energy over error energy as ffmpeg's `asdr` prints it (libavfilter
 * af_asdr.c lines 67, 68 and 228 of n9.0.2: the first input is the signal, and the benchmark feeds the decode there, so the
 * decode's energy is the signal).
 */
function snrDb(source: Int16Array, decoded: Int16Array): number {
  const length = Math.min(source.length, decoded.length);
  let sum = 0;
  for (let channel = 0; channel < CHANNELS; channel++) {
    let signal = 0;
    let noise = 0;
    for (let i = channel; i < length; i += CHANNELS) {
      signal += decoded[i] * decoded[i];
      noise += (source[i] - decoded[i]) ** 2;
    }
    sum += 10 * Math.log10(signal / noise);
  }
  return sum / CHANNELS;
}

describe('the alignment of an AAC encode in the quality benchmark', () => {
  for (const kbps of [48, 64, 128]) {
    oracleTest(
      `scores the ADTS encode of music.wav at ${kbps} kbit/s with the encoder's own delay removed`,
      ['ffmpeg'],
      () => {
        const adts = encode(kbps, 'aac');
        const mp4 = encode(kbps, 'm4a');
        const source = samples(MUSIC);
        const trimmed = samples(mp4);
        expect(exactShift(samples(adts), trimmed)).toBe(AAC_PRIMING_SAMPLES);
        const expected = snrDb(source, trimmed);
        expect(expected).toBeGreaterThan(8);
        const measured = measureAudioSnr(ffmpeg as string, adts, MUSIC, SAMPLE_RATE, CHANNELS, AAC_PRIMING_SAMPLES);
        expect(Math.abs(measured - expected)).toBeLessThan(SNR_TOLERANCE_DB);
      },
      120_000
    );
  }
});
