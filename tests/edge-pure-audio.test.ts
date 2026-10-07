import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import { tryProcessClientEdge } from '../src/lib/client-converter';
import { vi } from 'vitest';
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
    expect(isPureAudioConvertible('wav', 'mp3')).toBe(false);
    expect(isPureAudioConvertible('wav', 'wav')).toBe(true);
    expect(isPureAudioConvertible('pcm', 'wav')).toBe(false);
    expect(isPureAudioConvertible('raw', 'wav', { source: SOURCE })).toBe(true);
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
    expect(error.message).toMatch(/1 or 2 channels, and the audio has 6/);
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

describe('pure audio keeps the sample format of its source (issue #480)', () => {
  const RATE = 48_000;

  /** Interleaved little-endian bytes of `values` at 24 bits. */
  function int24Bytes(values: ArrayLike<number>): Uint8Array {
    const out = new Uint8Array(values.length * 3);
    for (let i = 0; i < values.length; i++) {
      const v = values[i] & 0xff_ffff;
      out.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff], i * 3);
    }
    return out;
  }

  function int32Bytes(values: ArrayLike<number>): Uint8Array {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) view.setInt32(i * 4, values[i], true);
    return out;
  }

  function float32Bytes(values: ArrayLike<number>): Uint8Array {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
    return out;
  }

  /** A two-tone signal as fractions of full scale, so every depth can be built from the same values. */
  const FRACTIONS = Array.from({ length: 600 }, (_, i) =>
    0.6 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 0.25 * Math.sin((2 * Math.PI * 1_800 * i) / RATE)
  );
  const SOURCES = [
    { name: '8-bit PCM', bits: 8, tag: 1, bytes: Uint8Array.from(FRACTIONS, (f) => Math.round(f * 127) + 128) },
    { name: '24-bit PCM', bits: 24, tag: 1, bytes: int24Bytes(FRACTIONS.map((f) => Math.round(f * 8_388_607))) },
    { name: '32-bit PCM', bits: 32, tag: 1, bytes: int32Bytes(FRACTIONS.map((f) => Math.round(f * 2_147_483_647))) },
    { name: '32-bit float', bits: 32, tag: 3, bytes: float32Bytes(FRACTIONS) },
  ];

  it.each(SOURCES)('writes $name back as $bits-bit samples with every sample byte unchanged', ({ bits, tag, bytes }) => {
    const source = craftWav({ sampleRate: RATE, channels: 1, bitsPerSample: bits, formatTag: tag, data: bytes });
    const res = convertPureAudio(source, 'wav', 'wav');
    const wav = walkWav(res.data);

    expect([wav.formatTag, wav.bitsPerSample, wav.channels, wav.sampleRate]).toEqual([tag, bits, 1, RATE]);
    expect(wav.dataSize).toBe(bytes.length);
    expect(Buffer.from(res.data.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize)).equals(Buffer.from(bytes))).toBe(true);
    // A float file states its sample count in a fact chunk (RIFF WAVE, non-PCM formats).
    if (tag === 3) expect([wav.chunkIds, wav.factSamples]).toEqual([['fmt ', 'fact', 'data'], FRACTIONS.length]);
  });

  it('writes a 24-bit stereo downmix as the rounded mean of the two 24-bit samples', () => {
    const left = FRACTIONS.map((f) => Math.round(f * 8_388_607));
    const right = FRACTIONS.map((f) => Math.round(-f * 4_000_000) + 3);
    const interleaved = left.flatMap((l, i) => [l, right[i]]);
    const source = craftWav({ sampleRate: RATE, channels: 2, bitsPerSample: 24, data: int24Bytes(interleaved) });
    const res = convertPureAudio(source, 'wav', 'wav', { channels: 1 });
    const wav = walkWav(res.data);
    expect([wav.channels, wav.bitsPerSample, wav.dataSize]).toEqual([1, 24, left.length * 3]);
    const expected = left.map((l, i) => Math.round((l + right[i]) / 2));
    expect(Buffer.from(res.data.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize)).equals(Buffer.from(int24Bytes(expected)))).toBe(true);
  });

  it('resamples 24-bit audio at 24 bits with a signal to noise ratio of at least 80 dB', () => {
    const tone = Array.from({ length: RATE }, (_, i) => Math.round(0.5 * 8_388_607 * Math.sin((2 * Math.PI * 1_000 * i) / RATE)));
    const source = craftWav({ sampleRate: RATE, channels: 1, bitsPerSample: 24, data: int24Bytes(tone) });
    const res = convertPureAudio(source, 'wav', 'wav', { sampleRate: 32_000 });
    const wav = walkWav(res.data);
    expect([wav.bitsPerSample, wav.sampleRate]).toEqual([24, 32_000]);
    const frames = wav.dataSize / 3;
    const view = new DataView(res.data.buffer, res.data.byteOffset + wav.dataOffset, wav.dataSize);
    const out = Float64Array.from({ length: frames }, (_, i) => (view.getUint8(i * 3) | (view.getUint8(i * 3 + 1) << 8) | (view.getInt8(i * 3 + 2) << 16)));
    const ideal = synthesizeTones([{ freq: 1_000, amp: 0.5 * 8_388_607, phase: 0 }], 32_000, frames);
    expect(snrDb(ideal, out, 2_000, frames - 4_000)).toBeGreaterThanOrEqual(80);
  });

  it('resamples float audio as float', () => {
    const tone = Array.from({ length: RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1_000 * i) / RATE));
    const source = craftWav({ sampleRate: RATE, channels: 1, bitsPerSample: 32, formatTag: 3, data: float32Bytes(tone) });
    const res = convertPureAudio(source, 'wav', 'wav', { sampleRate: 32_000 });
    const wav = walkWav(res.data);
    expect([wav.formatTag, wav.bitsPerSample, wav.sampleRate]).toEqual([3, 32, 32_000]);
    const frames = wav.dataSize / 4;
    const view = new DataView(res.data.buffer, res.data.byteOffset + wav.dataOffset, wav.dataSize);
    const out = Float64Array.from({ length: frames }, (_, i) => view.getFloat32(i * 4, true));
    const ideal = synthesizeTones([{ freq: 1_000, amp: 0.5, phase: 0 }], 32_000, frames);
    expect(snrDb(ideal, out, 2_000, frames - 4_000)).toBeGreaterThanOrEqual(80);
  });

  it('keeps described raw 24-bit PCM at 24 bits', () => {
    const raw = int24Bytes(FRACTIONS.map((f) => Math.round(f * 8_388_607)));
    const res = convertPureAudio(raw, 'pcm', 'wav', { source: { sampleRate: RATE, channels: 1, bitDepth: 24 } });
    const wav = walkWav(res.data);
    expect([wav.bitsPerSample, wav.dataSize]).toEqual([24, raw.length]);
    expect(Buffer.from(res.data.subarray(wav.dataOffset)).equals(Buffer.from(raw))).toBe(true);
  });

  it.each([3, 6])('refuses a %i-channel source instead of writing a layout it cannot describe', (channels) => {
    const source = craftWav({ sampleRate: RATE, channels, bitsPerSample: 24, data: new Uint8Array(channels * 3 * 50) });
    const error = failureOf(() => convertPureAudio(source, 'wav', 'wav'));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/1 or 2 channels/);
  });

  oracleTest('decodes to the same samples as the source according to ffmpeg', ['ffmpeg'], () => {
    const decode = (bytes: Uint8Array, format: string): Buffer => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'pure-audio-keep-'));
      try {
        const file = path.join(dir, 'in.wav');
        writeFileSync(file, bytes);
        const run = spawnSync(getOracleToolPath('ffmpeg') as string, ['-v', 'error', '-i', file, '-f', format, '-'], { maxBuffer: 1 << 26 });
        expect(run.status).toBe(0);
        return run.stdout;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    for (const [source, format] of [
      [SOURCES[1], 's32le'],
      [SOURCES[3], 'f32le'],
    ] as const) {
      const wav = craftWav({ sampleRate: RATE, channels: 1, bitsPerSample: source.bits, formatTag: source.tag, data: source.bytes });
      expect(decode(convertPureAudio(wav, 'wav', 'wav').data, format).equals(decode(wav, format))).toBe(true);
    }
  });
});

describe('no MP3 conversion reaches the pure engine (issue #480)', () => {
  const wav = craftWav({ sampleRate: 44_100, channels: 2, bitsPerSample: 16, data: int16Bytes(sineSamples(2_304, 2, 44_100, 440, 8_000)) });

  it.each([
    ['no capabilities named', undefined],
    ['every capability present', { hasCanvas: true, hasWebCodecsAudio: true, hasWebCodecsVideo: true, hasOpfsSyncAccess: true, hasWasmSimd: true }],
  ])('routes wav to mp3 to the server tier with %s', (_name, capabilities) => {
    const resolution = resolveConversionTier('wav', 'mp3', 200_000, {}, capabilities);
    expect(resolution.tier).toBe('L4');
    expect(resolution.isClientEdge).toBe(false);
  });

  it('refuses an MP3 target at the L0 entry with EdgeUnsupportedError', () => {
    const error = failureOf(() => convertPureAudio(wav, 'wav', 'mp3', { title: 'x' }));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/does not support conversion from 'wav' to 'mp3'/);
  });

  it('leaves an MP3 request to the server in the client converter, with nothing converted on the edge', async () => {
    vi.stubGlobal('window', globalThis);
    try {
      const file = new File([wav as BlobPart], 'song.wav', { type: 'audio/wav' });
      const result = await tryProcessClientEdge({
        id: 'mp3',
        file,
        name: 'song.wav',
        size: file.size,
        sourceFormat: 'wav',
        targetFormat: 'mp3',
        status: 'ready',
        progress: 0,
        options: {},
      });
      expect(result).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('has no call of the pure MP3 encoder in src besides the exported wrapper that delegates to it', () => {
    const callers = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          for (const line of readFileSync(full, 'utf8').split('\n')) {
            const isCall = /\b(encodePureMp3|pureEncodeMp3)\(/.test(line) && !/export function encodePureMp3\(/.test(line);
            if (isCall && !/^\s*(\*|\/\/|\/\*)/.test(line)) callers.add(path.relative(process.cwd(), full));
          }
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    // media-encoder.ts is a public wrapper that nothing in src calls; the router and the L0 entry never reach it.
    expect([...callers]).toEqual(['src/lib/conversions/media-encoder.ts']);
  });
});
