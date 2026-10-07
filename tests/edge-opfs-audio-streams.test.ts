import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorruptStreamError } from '../src/lib/types';
import { OPFS_CHUNK_SIZE, resolveChunkTransformer } from '../src/lib/edge/workers/opfs-vfs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import {
  isOpfsStreamingSupported,
  resolveConversionTier,
  SUPPORTED_OPFS_STREAMING_CONVERSIONS,
} from '../src/lib/edge/tier-router';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { mulberry32 } from './helpers/audio-signals';
import { snrDb } from './helpers/audio-spectrum';
import { failure, OPFS_ROUTES, runOpfsConversion, type OpfsRoute } from './helpers/opfs-run';
import { walkWav } from './helpers/riff-walker';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';

const MIB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- independent oracles -----------------------------------------------------------------------------------

function toolPath(tool: 'ffmpeg' | 'ffprobe'): string {
  const found = getOracleToolPath(tool);
  if (!found) throw new Error(`${tool} is required`);
  return found;
}

function withFile<T>(bytes: Uint8Array, extension: string, run: (file: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opfs-audio-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    writeFileSync(file, bytes);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ProbedAudio {
  codec_name: string;
  sample_rate: string;
  channels: number;
  duration: number;
}

function ffprobeAudio(bytes: Uint8Array): ProbedAudio {
  return withFile(bytes, 'wav', (file) => {
    const run = spawnSync(toolPath('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', file], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const stream = JSON.parse(run.stdout).streams[0];
    return {
      codec_name: stream.codec_name,
      sample_rate: stream.sample_rate,
      channels: stream.channels,
      duration: Number(stream.duration),
    };
  });
}

/** Decodes the file with the reference decoder to raw interleaved samples of the given ffmpeg format. */
function ffmpegDecode(bytes: Uint8Array, rawFormat: 's16le' | 'u8'): Buffer {
  return withFile(bytes, 'wav', (file) => {
    const run = spawnSync(toolPath('ffmpeg'), ['-v', 'error', '-i', file, '-f', rawFormat, '-'], {
      maxBuffer: 256 * MIB,
    });
    expect(run.stderr.toString()).toBe('');
    expect(run.status).toBe(0);
    return run.stdout;
  });
}

function listChunk(): { id: string; body: Uint8Array } {
  return { id: 'LIST', body: new TextEncoder().encode('INFOISFT\x05\x00\x00\x00test\x00\x00') };
}

/** The reference encoder's IMA ADPCM WAV of `source`. */
function ffmpegEncodeIma(source: Uint8Array): Uint8Array {
  return withFile(source, 'wav', (file) => {
    const out = `${file}.ima.wav`;
    const run = spawnSync(toolPath('ffmpeg'), ['-v', 'error', '-y', '-i', file, '-c:a', 'adpcm_ima_wav', out]);
    expect(run.status).toBe(0);
    return new Uint8Array(readFileSync(out));
  });
}

function asInt16(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Frames of noisy sine, enough that the file spans three OPFS windows. */
function stereoPcm(frames: number): Int16Array {
  const next = mulberry32(11);
  const tone = sineSamples(frames, 2, 48_000, 440, 9_000);
  for (let i = 0; i < tone.length; i++) tone[i] += Math.round((next() - 0.5) * 400);
  return tone;
}

/** IMA ADPCM step table and index adjustments from the IMA recommended practices, typed out for the oracle. */
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8];

/** A reference IMA ADPCM block decoder written from the recommended practices: header, then 4-byte nibble groups. */
function referenceDecodeIma(data: Uint8Array, channels: number, blockAlign: number, samplesPerBlock: number): Int16Array {
  const blocks = data.length / blockAlign;
  const out = new Int16Array(blocks * samplesPerBlock * channels);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let b = 0; b < blocks; b++) {
    const base = b * blockAlign;
    const predictor = new Array<number>(channels);
    const index = new Array<number>(channels);
    for (let c = 0; c < channels; c++) {
      predictor[c] = view.getInt16(base + 4 * c, true);
      index[c] = data[base + 4 * c + 2];
      out[(b * samplesPerBlock + 0) * channels + c] = predictor[c];
    }
    const groups = (blockAlign - 4 * channels) / (4 * channels);
    for (let g = 0; g < groups; g++) {
      for (let c = 0; c < channels; c++) {
        for (let k = 0; k < 8; k++) {
          const byte = data[base + 4 * channels + (g * channels + c) * 4 + (k >> 1)];
          const nibble = k % 2 === 0 ? byte & 0x0f : byte >> 4;
          const step = STEP_TABLE[index[c]];
          let diff = step >> 3;
          if (nibble & 4) diff += step;
          if (nibble & 2) diff += step >> 1;
          if (nibble & 1) diff += step >> 2;
          predictor[c] = Math.max(-32768, Math.min(32767, predictor[c] + (nibble & 8 ? -diff : diff)));
          index[c] = Math.max(0, Math.min(88, index[c] + INDEX_ADJUST[nibble & 7]));
          out[(b * samplesPerBlock + 1 + g * 8 + k) * channels + c] = predictor[c];
        }
      }
    }
  }
  return out;
}

function imaBlockAlign(rate: number, channels: number): number {
  return 256 * channels * Math.max(1, Math.floor(rate / 11_000));
}

function imaSamplesPerBlock(blockAlign: number, channels: number): number {
  return ((blockAlign - 4 * channels) * 2) / channels + 1;
}

// --- raw PCM to WAV ---------------------------------------------------------------------------------------

describe.each<OpfsRoute>(OPFS_ROUTES)('OPFS raw PCM to WAV, %s (issue #480)', (route) => {
  const FRAMES = 2_400_001;
  const PCM = int16Bytes(stereoPcm(FRAMES));
  const FORMAT = { sampleRate: 48_000, channels: 2, bitDepth: 16 };

  it('writes RIFF and data sizes that match the file when the input spans three windows', async () => {
    expect(PCM.length).toBeGreaterThan(2 * OPFS_CHUNK_SIZE);
    const { bytes } = await runOpfsConversion(route, 'pcm', 'wav', PCM, FORMAT);
    const wav = walkWav(bytes);

    expect(wav.riffSize).toBe(bytes.length - 8);
    expect(wav.chunkIds).toEqual(['fmt ', 'data']);
    expect([wav.formatTag, wav.channels, wav.sampleRate, wav.bitsPerSample]).toEqual([1, 2, 48_000, 16]);
    expect([wav.byteRate, wav.blockAlign]).toEqual([192_000, 4]);
    expect(wav.dataSize).toBe(PCM.length);
    expect(Buffer.from(bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize)).equals(Buffer.from(PCM))).toBe(true);
  });

  oracleTest('plays for exactly frames divided by rate and decodes to the source samples', ['ffmpeg', 'ffprobe'], async () => {
    const { bytes } = await runOpfsConversion(route, 'pcm', 'wav', PCM, FORMAT);
    const probed = ffprobeAudio(bytes);

    expect(probed.codec_name).toBe('pcm_s16le');
    expect(probed.sample_rate).toBe('48000');
    expect(probed.channels).toBe(2);
    expect(Math.abs(probed.duration - FRAMES / 48_000)).toBeLessThan(1 / 48_000);
    expect(ffmpegDecode(bytes, 's16le').equals(Buffer.from(PCM))).toBe(true);
  });

  it('writes the pad byte after an odd data chunk so the RIFF size stays exact', async () => {
    const mono8 = new Uint8Array([10, 20, 30, 40, 50]);
    const { bytes } = await runOpfsConversion(route, 'pcm', 'wav', mono8, { sampleRate: 8000, channels: 1, bitDepth: 8 });
    const wav = walkWav(bytes);

    expect(wav.dataSize).toBe(5);
    expect(bytes.length).toBe(44 + 5 + 1);
    expect(Array.from(bytes.subarray(wav.dataOffset, wav.dataOffset + 5))).toEqual([10, 20, 30, 40, 50]);
  });

  it.each([
    ['sampleRate', { channels: 2, bitDepth: 16 }],
    ['channels', { sampleRate: 48_000, bitDepth: 16 }],
    ['bitDepth', { sampleRate: 48_000, channels: 2 }],
  ])('refuses raw PCM that does not state %s', async (name, options) => {
    const error = await failure(runOpfsConversion(route, 'pcm', 'wav', PCM.subarray(0, 4096), options));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toContain(name);
  });

  it.each([
    [{ sampleRate: 0, channels: 2, bitDepth: 16 }],
    [{ sampleRate: 44_100.5, channels: 2, bitDepth: 16 }],
    [{ sampleRate: 48_000, channels: 0, bitDepth: 16 }],
    [{ sampleRate: 48_000, channels: 99, bitDepth: 16 }],
    [{ sampleRate: 48_000, channels: 2, bitDepth: 12 }],
  ])('refuses the raw PCM parameters %j', async (options) => {
    const error = await failure(runOpfsConversion(route, 'pcm', 'wav', PCM.subarray(0, 4096), options));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/sampleRate|channels|bitDepth/);
  });

  it('refuses input that ends inside a frame instead of dropping the partial frame', async () => {
    const error = await failure(runOpfsConversion(route, 'pcm', 'wav', PCM.subarray(0, 4099), FORMAT));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/whole number of frames/);
  });

  it('refuses the legacy bitsPerSample spelling with no bitDepth', async () => {
    const error = await failure(
      runOpfsConversion(route, 'pcm', 'wav', PCM.subarray(0, 4096), { sampleRate: 48_000, channels: 2, bitsPerSample: 16 })
    );
    expect(error).toMatchObject({ name: 'EdgeUnsupportedError', message: expect.stringContaining('bitDepth') });
  });
});

// --- endian swap and 8-bit ---------------------------------------------------------------------------------

describe.each<OpfsRoute>(OPFS_ROUTES)('OPFS PCM word transforms, %s (issue #480)', (route) => {
  function expectedSwap(input: Uint8Array, wordBytes: number): Uint8Array {
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i += wordBytes) {
      for (let k = 0; k < wordBytes; k++) out[i + k] = input[i + wordBytes - 1 - k];
    }
    return out;
  }

  it.each([
    [16, 2],
    [24, 3],
    [32, 4],
  ])('swaps %i-bit words across window boundaries without dropping or shifting a byte', async (bitDepth, wordBytes) => {
    const next = mulberry32(bitDepth);
    // 9 MiB of words: the 4 MiB window edge falls inside a 24-bit word.
    const words = Math.floor((9 * MIB) / wordBytes);
    const input = new Uint8Array(words * wordBytes);
    for (let i = 0; i < input.length; i++) input[i] = Math.floor(next() * 256);

    const { bytes } = await runOpfsConversion(route, 'pcm', 'pcm_be', input, { bitDepth });

    expect(bytes.length).toBe(input.length);
    expect(Buffer.from(expectedSwap(input, wordBytes)).equals(bytes)).toBe(true);
  });

  it('swaps big-endian back to little-endian', async () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const { bytes } = await runOpfsConversion(route, 'pcm_be', 'pcm', input, { bitDepth: 16 });
    expect(Array.from(bytes)).toEqual([2, 1, 4, 3, 6, 5]);
  });

  it.each([
    ['pcm', 'pcm_be'],
    ['pcm', 'pcm_u8'],
  ])('refuses an odd-length 16-bit input for %s to %s', async (source, target) => {
    const error = await failure(runOpfsConversion(route, source, target, new Uint8Array(7), { bitDepth: 16 }));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/whole number of 16-bit samples/);
  });

  it('refuses raw PCM that does not state its bit depth', async () => {
    const error = await failure(runOpfsConversion(route, 'pcm', 'pcm_be', new Uint8Array(8)));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error).toMatchObject({ message: expect.stringContaining('the bitDepth option has to state it') });
  });

  it('converts raw 16-bit PCM to raw unsigned 8-bit samples', async () => {
    const samples = Int16Array.from([-32768, -32767, -256, -1, 0, 1, 255, 256, 32767]);
    const { bytes } = await runOpfsConversion(route, 'pcm', 'pcm_u8', int16Bytes(samples), { bitDepth: 16 });
    // u8 = floor((s + 32768) / 256), the 8-bit sample that holds the top byte of the 16-bit one.
    expect(Array.from(bytes)).toEqual(Array.from(samples, (s) => Math.floor((s + 32768) / 256)));
  });
});

// --- WAV sources -------------------------------------------------------------------------------------------

describe.each<OpfsRoute>(OPFS_ROUTES)('OPFS WAV sources, %s (issue #480)', (route) => {
  const LIST_CHUNK = { id: 'LIST', body: new TextEncoder().encode('INFOISFT\x05\x00\x00\x00test\x00\x00') };
  const ODD_CHUNK = { id: 'junk', body: new Uint8Array([1, 2, 3]) };
  const TRAILER = { id: 'id3 ', body: new Uint8Array(40).fill(0x99) };
  const SAMPLES = Int16Array.from([-32768, -300, 0, 300, 32767, 12345, -12345, 1]);

  const sourceWav = (samples: Int16Array, channels = 1, rate = 8000): Uint8Array =>
    craftWav({
      sampleRate: rate,
      channels,
      bitsPerSample: 16,
      data: int16Bytes(samples),
      before: [LIST_CHUNK, ODD_CHUNK],
      after: [TRAILER],
    });

  it('writes a valid 8-bit WAV from a 16-bit WAV with extra chunks before and after the data', async () => {
    const { bytes } = await runOpfsConversion(route, 'wav', 'u8', sourceWav(SAMPLES));
    const wav = walkWav(bytes);

    expect(wav.chunkIds).toEqual(['fmt ', 'data']);
    expect([wav.formatTag, wav.channels, wav.sampleRate, wav.bitsPerSample, wav.blockAlign, wav.byteRate]).toEqual([
      1, 1, 8000, 8, 1, 8000,
    ]);
    expect(wav.dataSize).toBe(SAMPLES.length);
    expect(Array.from(bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize))).toEqual(
      Array.from(SAMPLES, (s) => Math.floor((s + 32768) / 256))
    );
  });

  it('keeps the rate and channel count of the source and pads an odd 8-bit data chunk', async () => {
    const stereo = Int16Array.from([100, -100, 200, -200, 300, -300]);
    const monoOdd = Int16Array.from([1000, 2000, 3000]);
    const stereoWav = walkWav((await runOpfsConversion(route, 'wav', 'u8', sourceWav(stereo, 2, 22_050))).bytes);
    expect([stereoWav.channels, stereoWav.sampleRate, stereoWav.dataSize]).toEqual([2, 22_050, 6]);

    const { bytes } = await runOpfsConversion(route, 'wav', 'u8', sourceWav(monoOdd));
    expect(walkWav(bytes).dataSize).toBe(3);
    expect(bytes.length).toBe(44 + 3 + 1);
  });

  oracleTest('decodes the 8-bit output as unsigned 8-bit audio of the source length', ['ffmpeg', 'ffprobe'], async () => {
    const tone = sineSamples(4000, 2, 16_000, 500, 20_000);
    const { bytes } = await runOpfsConversion(route, 'wav', 'u8', sourceWav(tone, 2, 16_000));
    const probed = ffprobeAudio(bytes);

    expect([probed.codec_name, probed.sample_rate, probed.channels]).toEqual(['pcm_u8', '16000', 2]);
    expect(Math.abs(probed.duration - 4000 / 16_000)).toBeLessThan(1 / 16_000);
    expect(Array.from(ffmpegDecode(bytes, 'u8'))).toEqual(Array.from(tone, (s) => Math.floor((s + 32768) / 256)));
  });

  it('writes raw unsigned 8-bit samples for wav to pcm_u8 without the header bytes', async () => {
    const { bytes } = await runOpfsConversion(route, 'wav', 'pcm_u8', sourceWav(SAMPLES));
    expect(Array.from(bytes)).toEqual(Array.from(SAMPLES, (s) => Math.floor((s + 32768) / 256)));
  });

  it('strips the whole header and the chunks after the data for wav to pcm', async () => {
    const { bytes } = await runOpfsConversion(route, 'wav', 'pcm', sourceWav(SAMPLES));
    expect(Buffer.from(int16Bytes(SAMPLES)).equals(bytes)).toBe(true);
  });

  it.each([
    ['an 8-bit source', craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 8, data: new Uint8Array(8) }), /8-bit/],
    [
      'a float source',
      craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 32, formatTag: 3, data: new Uint8Array(8) }),
      /float|16-bit/,
    ],
    ['a source that is not RIFF', new Uint8Array(64).fill(0x41), /RIFF\/WAVE/],
    [
      'a data chunk that runs past the file',
      craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: new Uint8Array(8), dataSizeField: 4000 }),
      /runs past the end/,
    ],
    [
      'a data chunk that ends inside a frame',
      craftWav({ sampleRate: 8000, channels: 2, bitsPerSample: 16, data: new Uint8Array(10) }),
      /whole number of frames/,
    ],
    ['a file with no data chunk', craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: new Uint8Array(8) }).subarray(0, 36), /data chunk/],
  ])('refuses %s', async (_name, input, pattern) => {
    const error = await failure(runOpfsConversion(route, 'wav', 'u8', input));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(pattern);
  });
});

// --- IMA ADPCM ---------------------------------------------------------------------------------------------

describe.each<OpfsRoute>(OPFS_ROUTES)('OPFS IMA ADPCM, %s (issue #480)', (route) => {
  const SNR_FLOOR_DB = 20;

  describe.each([
    [1, 22_050, 3 * 22_050 + 123],
    [2, 44_100, 44_100 + 777],
  ])('%i channel(s) at %i Hz', (channels, rate, frames) => {
    const tone = sineSamples(frames, channels, rate, 440, 12_000);
    const blockAlign = imaBlockAlign(rate, channels);
    const spb = imaSamplesPerBlock(blockAlign, channels);

    it('writes an IMA ADPCM WAV with the format, fact and block structure of the recommended practices', async () => {
      const { bytes } = await runOpfsConversion(
        route,
        'wav',
        'adpcm',
        craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(tone), before: [listChunk()] })
      );
      const wav = walkWav(bytes);

      expect(wav.chunkIds).toEqual(['fmt ', 'fact', 'data']);
      expect([wav.formatTag, wav.channels, wav.sampleRate, wav.bitsPerSample]).toEqual([0x11, channels, rate, 4]);
      expect([wav.blockAlign, wav.cbSize, wav.samplesPerBlock]).toEqual([blockAlign, 2, spb]);
      expect(wav.byteRate).toBe(Math.round((rate * blockAlign) / spb));
      expect(wav.factSamples).toBe(frames);
      expect(wav.dataSize).toBe(Math.ceil(frames / spb) * blockAlign);
      // The first block of every channel opens with that channel's first sample and a step index in range.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let c = 0; c < channels; c++) {
        expect(view.getInt16(wav.dataOffset + 4 * c, true)).toBe(tone[c]);
        expect(bytes[wav.dataOffset + 4 * c + 2]).toBeLessThanOrEqual(88);
        expect(bytes[wav.dataOffset + 4 * c + 3]).toBe(0);
      }
    });

    oracleTest('decodes with ffmpeg at a signal to noise ratio of at least 20 dB', ['ffmpeg', 'ffprobe'], async () => {
      const { bytes } = await runOpfsConversion(
        route,
        'wav',
        'adpcm',
        craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(tone) })
      );
      const probed = ffprobeAudio(bytes);
      expect([probed.codec_name, probed.sample_rate, probed.channels]).toEqual(['adpcm_ima_wav', String(rate), channels]);

      const decoded = asInt16(ffmpegDecode(bytes, 's16le'));
      expect(decoded.length).toBeGreaterThanOrEqual(frames * channels);
      const snr = snrDb(tone, decoded, 0, frames * channels);
      expect(snr).toBeGreaterThanOrEqual(SNR_FLOOR_DB);
    });

    it('decodes with the reference decoder to the same samples the encoder was following', async () => {
      const { bytes } = await runOpfsConversion(
        route,
        'wav',
        'adpcm',
        craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(tone) })
      );
      const wav = walkWav(bytes);
      const decoded = referenceDecodeIma(bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize), channels, blockAlign, spb);
      expect(snrDb(tone, decoded, 0, frames * channels)).toBeGreaterThanOrEqual(SNR_FLOOR_DB);
    });

    it('pads the last block with silence, not with a repeat of the last frame', async () => {
      const { bytes } = await runOpfsConversion(
        route,
        'wav',
        'adpcm',
        craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(tone) })
      );
      const wav = walkWav(bytes);
      expect(frames % spb).not.toBe(0);
      const decoded = referenceDecodeIma(bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize), channels, blockAlign, spb);
      const padded = decoded.length / channels - frames;
      expect(padded).toBeGreaterThan(8);
      // The padding decodes towards zero: the last frames of the file are near silence, where a repeat of the
      // last frame would hold it at the level the tone had there.
      const lastPadding = Array.from(decoded.subarray(decoded.length - 4 * channels), Math.abs);
      expect(Math.max(...lastPadding)).toBeLessThanOrEqual(240);
      // The fact chunk still states the real length, and the real samples are unchanged in quality.
      expect(wav.factSamples).toBe(frames);
      expect(snrDb(tone, decoded, 0, frames * channels)).toBeGreaterThanOrEqual(SNR_FLOOR_DB);
    });

    it('takes raw 16-bit PCM with explicit parameters and writes the same ADPCM as the WAV source', async () => {
      const raw = await runOpfsConversion(route, 'pcm', 'adpcm', int16Bytes(tone), { sampleRate: rate, channels, bitDepth: 16 });
      const fromWav = await runOpfsConversion(
        route,
        'wav',
        'adpcm',
        craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(tone) })
      );
      expect(raw.bytes.equals(fromWav.bytes)).toBe(true);
    });

    oracleTest('decodes an ffmpeg-made IMA ADPCM WAV to PCM within 40 dB of the reference decoder', ['ffmpeg'], async () => {
      const imaWav = ffmpegEncodeIma(craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(tone) }));
      const stated = walkWav(imaWav);
      const ffmpegPcm = asInt16(ffmpegDecode(imaWav, 's16le'));
      const { bytes } = await runOpfsConversion(route, 'adpcm', 'wav', imaWav);
      const wav = walkWav(bytes);

      expect([wav.formatTag, wav.channels, wav.sampleRate, wav.bitsPerSample]).toEqual([1, channels, rate, 16]);
      // The decoded length is the sample count the file's fact chunk states, not the block padding.
      expect(wav.dataSize).toBe((stated.factSamples as number) * channels * 2);
      const ours = asInt16(bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize));
      const compared = Math.min(ours.length, ffmpegPcm.length);
      expect(compared).toBeGreaterThanOrEqual(frames * channels);
      expect(snrDb(ffmpegPcm, ours, 0, compared)).toBeGreaterThanOrEqual(40);
      expect(snrDb(tone, ours, 0, frames * channels)).toBeGreaterThanOrEqual(SNR_FLOOR_DB);
    });

    it('decodes its own ADPCM back to raw PCM and PCM WAV that agree with the reference decoder', async () => {
      const encoded = await runOpfsConversion(
        route,
        'wav',
        'adpcm',
        craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(tone) })
      );
      const walked = walkWav(encoded.bytes);
      const expected = referenceDecodeIma(
        encoded.bytes.subarray(walked.dataOffset, walked.dataOffset + walked.dataSize),
        channels,
        blockAlign,
        spb
      ).subarray(0, frames * channels);

      const rawOut = await runOpfsConversion(route, 'adpcm', 'pcm', encoded.bytes);
      expect(Buffer.from(int16Bytes(expected)).equals(rawOut.bytes)).toBe(true);

      const wavOut = await runOpfsConversion(route, 'adpcm', 'wav', encoded.bytes);
      const decoded = walkWav(wavOut.bytes);
      expect(decoded.dataSize).toBe(frames * channels * 2);
      expect(
        Buffer.from(int16Bytes(expected)).equals(
          Buffer.from(wavOut.bytes.subarray(decoded.dataOffset, decoded.dataOffset + decoded.dataSize))
        )
      ).toBe(true);
    });
  });

  it.each([
    ['three channels', craftWav({ sampleRate: 8000, channels: 3, bitsPerSample: 16, data: new Uint8Array(60) }), /1 or 2 channels/],
    ['24-bit samples', craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 24, data: new Uint8Array(60) }), /16-bit/],
  ])('refuses to encode %s', async (_name, input, pattern) => {
    const error = await failure(runOpfsConversion(route, 'wav', 'adpcm', input));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(pattern);
  });

  it('refuses raw PCM to ADPCM without explicit parameters', async () => {
    const error = await failure(runOpfsConversion(route, 'pcm', 'adpcm', new Uint8Array(64)));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/sampleRate|channels|bitDepth/);
  });

  describe('decoding refusals', () => {
    const mono = sineSamples(2000, 1, 8000, 300, 8000);
    const encode = async (): Promise<Buffer> =>
      (await runOpfsConversion(route, 'wav', 'adpcm', craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: int16Bytes(mono) })))
        .bytes;

    it('refuses a WAV whose format is not IMA ADPCM', async () => {
      const pcm = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: int16Bytes(mono) });
      const error = await failure(runOpfsConversion(route, 'adpcm', 'wav', pcm));
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect(error.message).toMatch(/not IMA ADPCM/);
    });

    it('refuses data that ends inside a block', async () => {
      const bytes = await encode();
      const error = await failure(runOpfsConversion(route, 'adpcm', 'wav', bytes.subarray(0, bytes.length - 3)));
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect(error.message).toMatch(/data chunk of \d+ bytes runs past the end of the file/);
    });

    it('fails a block whose step index is out of range with CorruptStreamError', async () => {
      const bytes = Buffer.from(await encode());
      const wav = walkWav(bytes);
      bytes[wav.dataOffset + 2] = 200;
      const error = await failure(runOpfsConversion(route, 'adpcm', 'wav', bytes));
      expect(error).toBeInstanceOf(CorruptStreamError);
      expect(error.message).toMatch(/step index 200/);
    });
  });
});

// --- escape hatches and the router -------------------------------------------------------------------------

describe('OPFS audio escape hatches and routing (issue #480)', () => {
  it.each([
    ['bin', 'invert', {}],
    ['bin', 'bin', {}],
    ['raw', 'dat', { allowPassThrough: true }],
    ['raw', 'dat', { chunkTransformer: (chunk: Uint8Array) => chunk }],
    ['raw', 'dat', { invert: true }],
  ])('refuses %s to %s with options %j instead of copying or inverting the bytes', (source, target, options) => {
    expect(() => resolveChunkTransformer(source, target, options)).toThrow(EdgeUnsupportedError);
    expect(() => resolveChunkTransformer(source, target, options)).toThrow(/Unsupported streaming transformation/);
  });

  const FORMAT = { sampleRate: 48_000, channels: 2, bitDepth: 16 };
  const LARGE = 200 * MIB;
  const caps = { hasOpfsSyncAccess: true };

  it.each([
    ['pcm', 'wav'],
    ['pcm', 'u8'],
    ['pcm', 'adpcm'],
  ])('routes raw %s to %s to the server tier until the parameters are explicit', (source, target) => {
    expect(isOpfsStreamingSupported(source, target)).toBe(false);
    expect(resolveConversionTier(source, target, LARGE, {}, caps).tier).toBe('L4');
    expect(isOpfsStreamingSupported(source, target, FORMAT)).toBe(true);
    expect(resolveConversionTier(source, target, LARGE, FORMAT as never, caps).tier).toBe('L3');
  });

  it.each([
    ['pcm', 'pcm_be'],
    ['pcm', 'pcm_u8'],
    ['pcm_le', 'pcm_be'],
    ['pcm_be', 'pcm_le'],
    ['pcm_be', 'pcm'],
  ])('routes raw %s to %s to the server tier until the bit depth is stated', (source, target) => {
    expect(resolveConversionTier(source, target, LARGE, {}, caps).tier).toBe('L4');
    expect(resolveConversionTier(source, target, LARGE, { bitDepth: 16 } as never, caps).tier).toBe('L3');
  });

  it.each([
    ['wav', 'u8'],
    ['wav', 'pcm_u8'],
    ['wav', 'pcm'],
    ['wav', 'adpcm'],
    ['adpcm', 'wav'],
    ['adpcm', 'pcm'],
  ])('routes self-describing %s to %s to the OPFS tier', (source, target) => {
    expect(resolveConversionTier(source, target, LARGE, {}, caps).tier).toBe('L3');
  });

  it('lists exactly the pairs that have a real transformation', () => {
    // A hand-written list: a pair added to the router without a transformation and a test has to change this.
    expect([...SUPPORTED_OPFS_STREAMING_CONVERSIONS].sort()).toEqual(
      [
        'adpcm:pcm',
        'adpcm:wav',
        'csv:tab',
        'csv:tsv',
        'gz:tar',
        'pcm:adpcm',
        'pcm:pcm_be',
        'pcm:pcm_u8',
        'pcm:u8',
        'pcm:wav',
        'pcm_be:pcm',
        'pcm_be:pcm_le',
        'pcm_le:pcm_be',
        'raw:gray',
        'raw:grayscale',
        'rgba:gray',
        'rgba:grayscale',
        'tab:csv',
        'tar:gz',
        'tar:tar_gz',
        'tar_gz:tar',
        'tsv:csv',
        'wav:adpcm',
        'wav:pcm',
        'wav:pcm_u8',
        'wav:u8',
      ].sort()
    );
  });

  it.each([
    ['tar', 'tar_gz'],
    ['gz', 'tar'],
    ['csv', 'tsv'],
    ['rgba', 'grayscale'],
  ])('routes the listed pair %s to %s to the OPFS tier', (source, target) => {
    expect(resolveConversionTier(source, target, LARGE, {}, caps).tier).toBe('L3');
  });

  it.each([
    ['tar_gz', 'gz'],
    ['grayscale', 'rgba'],
    ['tsv', 'tar'],
    ['wav', 'wav'],
    ['mp4', 'webm'],
  ])('routes the unlisted pair %s to %s to the server tier', (source, target) => {
    expect(resolveConversionTier(source, target, LARGE, {}, caps).tier).toBe('L4');
  });

  it('no longer lets an option turn an identity copy into a streaming conversion', () => {
    expect(isOpfsStreamingSupported('raw', 'raw', { allowPassThrough: true } as never)).toBe(false);
    expect(resolveConversionTier('raw', 'raw', LARGE, { allowPassThrough: true } as never, caps).tier).toBe('L4');
  });
});
