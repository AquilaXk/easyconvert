import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import {
  convertPureAudio,
  encodePcmToWav,
  isPureAudioConvertible,
  parseWavPcm,
} from '../src/lib/edge/pure/pure-audio';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { snrDb, synthesizeTones } from './helpers/audio-spectrum';
import { walkWav } from './helpers/riff-walker';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';

function toInt16(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function failureOf(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call returned but was expected to throw');
}

/** Frequency of a tone from its upward zero crossings over the interior of the signal (channel `channel` of `channels`). */
function toneFrequency(samples: Int16Array, channels: number, channel: number, rate: number): number {
  const frames = samples.length / channels;
  const first = Math.floor(frames * 0.1);
  const last = Math.floor(frames * 0.9);
  const crossings: number[] = [];
  for (let i = first + 1; i < last; i++) {
    const before = samples[(i - 1) * channels + channel];
    const after = samples[i * channels + channel];
    if (before < 0 && after >= 0) crossings.push(i - 1 + -before / (after - before));
  }
  const periods = crossings.length - 1;
  return (periods * rate) / (crossings[crossings.length - 1] - crossings[0]);
}

describe('pure audio reads WAV strictly (issue #480)', () => {
  const TONE = sineSamples(480, 1, 48_000, 1_000, 10_000);

  it('refuses a WAV whose format tag is not integer PCM or float', () => {
    // IMA ADPCM, A-law and mu-law data are not 16-bit samples, whatever the bit depth field says.
    for (const formatTag of [0x11, 6, 7, 0x55]) {
      const wav = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, formatTag, data: new Uint8Array(64) });
      const error = failureOf(() => parseWavPcm(wav));
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect(error.message).toMatch(new RegExp(`format tag 0x${formatTag.toString(16)}`));
    }
  });

  it('reads 8, 16, 24 and 32-bit integer PCM and 32-bit float into 16-bit samples', () => {
    const expected = Int16Array.from([-32768, -16384, 0, 16384, 32767]);
    const u8 = Uint8Array.from(expected, (s) => (s >> 8) + 128);
    const s24 = new Uint8Array(expected.length * 3);
    const s32 = new Uint8Array(expected.length * 4);
    const f32 = new Uint8Array(expected.length * 4);
    expected.forEach((s, i) => {
      new DataView(s24.buffer).setInt16(i * 3 + 1, s, true);
      new DataView(s32.buffer).setInt32(i * 4, s * 65_536, true);
      new DataView(f32.buffer).setFloat32(i * 4, s / 32_768, true);
    });
    const read = (bits: number, data: Uint8Array, formatTag = 1): number[] =>
      Array.from(parseWavPcm(craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: bits, formatTag, data })).samples);

    expect(read(8, u8)).toEqual(Array.from(expected, (s) => (s >> 8) << 8));
    expect(read(24, s24)).toEqual(Array.from(expected));
    expect(read(32, s32)).toEqual(Array.from(expected));
    // Float scaling to 16 bits rounds to the nearest sample.
    expect(read(32, f32, 3)).toEqual(Array.from(expected, (s) => Math.max(-32768, Math.min(32767, Math.round((s / 32_768) * 32_767)))));
  });

  it('reads the audio of a file with chunks before and after the data chunk', () => {
    const wav = craftWav({
      sampleRate: 48_000,
      channels: 1,
      bitsPerSample: 16,
      data: int16Bytes(TONE),
      before: [{ id: 'LIST', body: new Uint8Array(11) }],
      after: [{ id: 'id3 ', body: new Uint8Array(33).fill(7) }],
    });
    const parsed = parseWavPcm(wav);
    expect([parsed.sampleRate, parsed.channels, parsed.samples.length]).toEqual([48_000, 1, TONE.length]);
    expect(Array.from(parsed.samples)).toEqual(Array.from(TONE));
  });

  it.each([
    ['a data chunk longer than the file', craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: new Uint8Array(20), dataSizeField: 400 }), /runs past the end/],
    ['a data chunk that ends inside a frame', craftWav({ sampleRate: 8000, channels: 2, bitsPerSample: 16, data: new Uint8Array(10) }), /whole number of frames/],
    ['a data chunk with no audio', craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: new Uint8Array(0) }), /no audio/],
    ['bytes that are not RIFF', new Uint8Array(200).fill(0x20), /RIFF\/WAVE/],
  ])('refuses %s instead of clamping or padding it', (_name, wav, pattern) => {
    const error = failureOf(() => parseWavPcm(wav));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(pattern);
  });
});

describe('pure audio takes raw PCM only when it is described (issue #480)', () => {
  const SOURCE = { sampleRate: 22_050, channels: 2, bitDepth: 16 };
  const SAMPLES = sineSamples(300, 2, 22_050, 440, 9_000);

  it('refuses raw PCM with no stated parameters instead of assuming 44.1 kHz stereo', () => {
    const error = failureOf(() => convertPureAudio(int16Bytes(SAMPLES), 'pcm', 'wav'));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/raw PCM has no header/);
    const raw = failureOf(() => parseWavPcm(int16Bytes(SAMPLES)));
    expect(raw).toBeInstanceOf(EdgeUnsupportedError);
  });

  it.each([
    [{ sampleRate: 0, channels: 2, bitDepth: 16 }],
    [{ sampleRate: 22_050, channels: 0, bitDepth: 16 }],
    [{ sampleRate: 22_050, channels: 2, bitDepth: 12 }],
  ])('refuses the raw PCM description %j', (source) => {
    const error = failureOf(() => convertPureAudio(int16Bytes(SAMPLES), 'raw', 'wav', { source }));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/sampleRate|channels|bitDepth/);
  });

  it('writes a WAV that states the described rate and channels and holds the described samples', () => {
    const res = convertPureAudio(int16Bytes(SAMPLES), 'pcm', 'wav', { source: SOURCE });
    const wav = walkWav(res.data);
    expect([wav.formatTag, wav.channels, wav.sampleRate, wav.bitsPerSample, wav.dataSize]).toEqual([1, 2, 22_050, 16, SAMPLES.length * 2]);
    expect(Array.from(toInt16(res.data.subarray(wav.dataOffset)))).toEqual(Array.from(SAMPLES));
  });

  it('refuses raw PCM that ends inside a frame', () => {
    const error = failureOf(() => convertPureAudio(int16Bytes(SAMPLES).subarray(0, 1001), 'pcm', 'wav', { source: SOURCE }));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/whole number of frames/);
  });

  it('is convertible, and routed to the edge, only for raw sources that describe themselves', () => {
    expect(isPureAudioConvertible('wav', 'mp3')).toBe(true);
    expect(isPureAudioConvertible('wav', 'wav')).toBe(true);
    expect(isPureAudioConvertible('pcm', 'wav')).toBe(false);
    expect(isPureAudioConvertible('raw', 'mp3', { source: SOURCE })).toBe(true);
    expect(isPureAudioConvertible('wav', 'flac')).toBe(false);
    expect(resolveConversionTier('pcm', 'wav', 1_000_000).tier).toBe('L4');
    expect(resolveConversionTier('wav', 'wav', 1_000_000).tier).toBe('L0');
  });
});

describe('pure audio resamples and remixes for real (issue #480)', () => {
  const FRAMES = 48_000;
  const RATE = 48_000;
  const FREQ = 1_000;

  /** A stereo WAV: 1 kHz in the left channel at 10000, half that in the right. */
  const stereoWav = (): Uint8Array =>
    craftWav({ sampleRate: RATE, channels: 2, bitsPerSample: 16, data: int16Bytes(sineSamples(FRAMES, 2, RATE, FREQ, 10_000)) });

  it('changes the sample rate by resampling: more or fewer frames, the same tone', () => {
    const res = convertPureAudio(stereoWav(), 'wav', 'wav', { sampleRate: 44_100 });
    const wav = walkWav(res.data);
    const out = toInt16(res.data.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize));

    expect([wav.sampleRate, wav.channels, wav.byteRate]).toEqual([44_100, 2, 44_100 * 4]);
    // One second in is one second out: 48000 frames at 48 kHz become 44100 frames at 44.1 kHz.
    expect(Math.abs(wav.dataSize / 4 - 44_100)).toBeLessThanOrEqual(1);
    expect(Math.abs(toneFrequency(out, 2, 0, 44_100) - FREQ)).toBeLessThan(FREQ * 0.005);
    expect(Math.abs(toneFrequency(out, 2, 1, 44_100) - FREQ)).toBeLessThan(FREQ * 0.005);
  });

  it('matches the analytic tone at the new rate with a signal to noise ratio of at least 60 dB', () => {
    const res = convertPureAudio(stereoWav(), 'wav', 'wav', { sampleRate: 32_000 });
    const wav = walkWav(res.data);
    const out = toInt16(res.data.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize));
    const frames = out.length / 2;
    const ideal = synthesizeTones([{ freq: FREQ, amp: 10_000, phase: 0 }], 32_000, frames);
    const left = Float64Array.from({ length: frames }, (_, i) => out[i * 2]);
    // The interior, clear of the filter's edge response.
    expect(snrDb(ideal, left, 2_000, frames - 4_000)).toBeGreaterThanOrEqual(60);
  });

  it('downmixes stereo to mono as the mean of the two channels', () => {
    const source = sineSamples(FRAMES, 2, RATE, FREQ, 10_000);
    const res = convertPureAudio(stereoWav(), 'wav', 'wav', { channels: 1 });
    const wav = walkWav(res.data);
    const out = toInt16(res.data.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize));

    expect([wav.channels, wav.sampleRate, wav.blockAlign]).toEqual([1, RATE, 2]);
    expect(out.length).toBe(FRAMES);
    for (let i = 0; i < FRAMES; i += 97) {
      expect(Math.abs(out[i] - (source[i * 2] + source[i * 2 + 1]) / 2)).toBeLessThanOrEqual(0.5);
    }
  });

  it('upmixes mono to stereo with the same samples in both channels', () => {
    const mono = sineSamples(2_000, 1, RATE, FREQ, 10_000);
    const res = convertPureAudio(craftWav({ sampleRate: RATE, channels: 1, bitsPerSample: 16, data: int16Bytes(mono) }), 'wav', 'wav', { channels: 2 });
    const wav = walkWav(res.data);
    const out = toInt16(res.data.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize));
    expect(wav.channels).toBe(2);
    expect(Array.from(out.filter((_, i) => i % 2 === 0))).toEqual(Array.from(mono));
    expect(Array.from(out.filter((_, i) => i % 2 === 1))).toEqual(Array.from(mono));
  });

  it('remixes and resamples in one conversion', () => {
    const res = convertPureAudio(stereoWav(), 'wav', 'wav', { channels: 1, sampleRate: 24_000 });
    const wav = walkWav(res.data);
    const out = toInt16(res.data.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize));
    expect([wav.channels, wav.sampleRate]).toEqual([1, 24_000]);
    expect(Math.abs(out.length - 24_000)).toBeLessThanOrEqual(1);
    // Mean of 10000 and 5000 is a 7500 peak at the same frequency.
    expect(Math.abs(toneFrequency(out, 1, 0, 24_000) - FREQ)).toBeLessThan(FREQ * 0.005);
    expect(Math.max(...Array.from(out.subarray(2_000, 6_000)))).toBeGreaterThan(7_300);
    expect(Math.max(...Array.from(out.subarray(2_000, 6_000)))).toBeLessThan(7_700);
  });

  it('keeps the source layout and rate when the options name none', () => {
    const res = convertPureAudio(stereoWav(), 'wav', 'wav');
    const wav = walkWav(res.data);
    expect([wav.channels, wav.sampleRate, wav.dataSize]).toEqual([2, RATE, FRAMES * 4]);
  });

  it.each([3, 6, 8])('refuses to remix stereo to %i channels instead of relabelling the header', (channels) => {
    const error = failureOf(() => convertPureAudio(stereoWav(), 'wav', 'wav', { channels }));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/channels/);
  });

  it('refuses to remix a 5.1 source', () => {
    const surround = craftWav({ sampleRate: RATE, channels: 6, bitsPerSample: 16, data: new Uint8Array(6 * 2 * 100) });
    const error = failureOf(() => convertPureAudio(surround, 'wav', 'wav', { channels: 2 }));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/remixing 6 channels to 2 channels is not done on the edge/);
  });

  it.each([0, -1, 1.5, 500, 5_000_000])('refuses the sample rate %s', (sampleRate) => {
    const error = failureOf(() => convertPureAudio(stereoWav(), 'wav', 'wav', { sampleRate }));
    expect(error.name).toMatch(/Error$/);
    expect(error.message).toMatch(/rate|Hz/i);
  });

  oracleTest('plays at the requested rate and channel count according to ffprobe', ['ffprobe'], () => {
    const res = convertPureAudio(stereoWav(), 'wav', 'wav', { channels: 1, sampleRate: 22_050 });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pure-audio-'));
    try {
      const file = path.join(dir, 'out.wav');
      writeFileSync(file, res.data);
      const run = spawnSync(getOracleToolPath('ffprobe') as string, ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      const stream = JSON.parse(run.stdout).streams[0];
      expect([stream.codec_name, stream.sample_rate, stream.channels]).toEqual(['pcm_s16le', '22050', 1]);
      expect(Math.abs(Number(stream.duration) - FRAMES / RATE)).toBeLessThan(2 / 22_050);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a sample count that is a whole number of frames', () => {
    expect(failureOf(() => encodePcmToWav(new Int16Array(5), 44_100, 2)).message).toMatch(/whole number of frames/);
  });
});
