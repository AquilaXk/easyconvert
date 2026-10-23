import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeFfmpegBuild } from '../src/lib/conversions/media-audio-quality';
import { buildFfmpegArguments, buildLoudnessMeasureArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { wavPacketBytes, wavPacketSizeKeepsOutput } from '../src/lib/conversions/media-wav-input';
import type { ConversionOptions } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';

/**
 * ffmpeg's WAV demuxer cuts a file into 4096-byte packets and ffmpeg 6.1 passes each one through four threads, which costs a
 * third of a FLAC encode of a few seconds. A conversion that only changes container and codec reads the file in about 32
 * packets instead; one that resamples, mixes, filters, dithers or trims keeps the default packets, and so does a build whose
 * encoder takes its block size from the first frame. The oracle is the reference encoder itself, run on the same file with and
 * without the option.
 */

const PACKET_BYTES_OF_TWELVE_SECONDS = 66_150;
const RATE = 44_100;
const STEREO = 2;
const BITS_16 = 16;
const BITS_24 = 24;
const FRAME_BYTES_16 = 4;
const FRAME_BYTES_24 = 6;
const TWELVE_SECONDS = 12;
const TEST_TIMEOUT_MS = 120_000;
const ENCODERS = ['flac', 'libmp3lame', 'aac', 'libvorbis', 'libopus', 'pcm_s16le', 'pcm_s16be', 'libx264'];

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wav-packet-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** An `ffmpeg` that states a release and lists encoders, for the tests that only read the arguments. */
function stubFfmpeg(release: string): string {
  const dir = path.join(workDir, `stub-${release.replace(/\W/g, '_')}`);
  fs.mkdirSync(dir, { recursive: true });
  const listing = ENCODERS.map((name) => ` A....D ${name.padEnd(20)} stub`).join('\\n');
  const script = `#!/bin/sh\ncase "$*" in\n  *-encoders*) printf ' ------\\n${listing}\\n' ;;\n  *) echo 'ffmpeg version ${release} Copyright (c) 2000-2023 the FFmpeg developers' ;;\nesac\n`;
  const file = path.join(dir, 'ffmpeg');
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

function writeWav(name: string, rate: number, seconds: number, bitsPerSample: number = BITS_16): string {
  const frames = Math.round(rate * seconds);
  const file = path.join(workDir, name);
  const data =
    bitsPerSample === BITS_16
      ? int16Bytes(sineSamples(frames, STEREO, rate, 440, 12_000))
      : new Uint8Array(frames * STEREO * (bitsPerSample / 8)).map((_, i) => (i * 37) & 0xff);
  fs.writeFileSync(file, craftWav({ sampleRate: rate, channels: STEREO, bitsPerSample, data }));
  return file;
}

function packetSizeOf(args: string[]): string | undefined {
  const at = args.indexOf('-max_size');
  return at === -1 ? undefined : args[at + 1];
}

describe('the packet size for a WAVE file', () => {
  it('is a thirty-second part of the file, from the demuxer default up to 128 KiB', () => {
    expect(wavPacketBytes(RATE * FRAME_BYTES_24 * TWELVE_SECONDS)).toBe(99_225);
    expect(wavPacketBytes(RATE * FRAME_BYTES_16 * TWELVE_SECONDS)).toBe(PACKET_BYTES_OF_TWELVE_SECONDS);
    expect(wavPacketBytes(64 * 1024 * 1024)).toBe(128 * 1024);
  });

  it('leaves a file the default packet already cuts into 32 or more parts alone', () => {
    expect(wavPacketBytes(4096 * 32)).toBeUndefined();
    expect(wavPacketBytes(4096 * 32 + 31)).toBeUndefined();
    expect(wavPacketBytes(4097 * 32)).toBe(4097);
    expect(wavPacketBytes(0)).toBeUndefined();
  });

  it.each([
    ['4.0', 4, 0, false],
    ['4.3', 4, 3, false],
    ['4.4', 4, 4, true],
    ['5.1', 5, 1, true],
    ['6.1', 6, 1, true],
    ['7.1', 7, 1, true],
    ['8.0', 8, 0, true],
    ['8.1', 8, 1, false],
    ['9.0', 9, 0, false],
  ])('is used with FFmpeg %s: %s', (_label, major, minor, expected) => {
    expect(wavPacketSizeKeepsOutput({ major, minor })).toBe(expected);
  });

  it('is not used with a build whose release is not known', () => {
    expect(wavPacketSizeKeepsOutput(undefined)).toBe(false);
  });
});

describe('the arguments of a conversion from a WAVE file', () => {
  const ffmpeg = (): string => stubFfmpeg('6.1.1-3ubuntu5');

  it.each(['flac', 'mp3', 'aac', 'm4a', 'ogg'])('read the %s conversion in packets, beside the minimal probe and ahead of the input', (target) => {
    const input = writeWav(`args-${target}.wav`, RATE, TWELVE_SECONDS);
    const args = buildFfmpegArguments(input, path.join(workDir, `o.${target}`), 'wav', target, {}, ffmpeg());
    const at = args.indexOf('-i');
    expect(args.slice(at - 4, at + 2)).toEqual(['-probesize', '32', '-max_size', String(PACKET_BYTES_OF_TWELVE_SECONDS), '-i', input]);
  });

  it('keep the default packets for a file too short to be cut into 32 packets of more than the default', () => {
    const input = writeWav('args-short.wav', RATE, 0.5);
    expect(packetSizeOf(buildFfmpegArguments(input, path.join(workDir, 'o.flac'), 'wav', 'flac', {}, ffmpeg()))).toBeUndefined();
  });

  it.each(['9.0.2', '8.1', 'N-118123-gabcdef0123'])('keep the default packets with an ffmpeg that is %s', (release) => {
    const input = writeWav('args-release.wav', RATE, TWELVE_SECONDS);
    expect(packetSizeOf(buildFfmpegArguments(input, path.join(workDir, 'o.flac'), 'wav', 'flac', {}, stubFfmpeg(release)))).toBeUndefined();
  });

  it('keep the default packets when there is no ffmpeg to ask', () => {
    const input = writeWav('args-nobinary.wav', RATE, TWELVE_SECONDS);
    expect(packetSizeOf(buildFfmpegArguments(input, path.join(workDir, 'o.flac'), 'wav', 'flac', {}, null))).toBeUndefined();
  });

  it.each<[string, string, ConversionOptions]>([
    ['a start time', 'flac', { trim: { start: '00:00:01.000' } }],
    ['an end time', 'flac', { trim: { end: '00:00:03.000' } }],
    ['a sample rate', 'flac', { audio: { sampleRate: 22_050 } }],
    ['a channel count', 'flac', { audio: { channels: 1 } }],
    ['a volume', 'mp3', { audio: { volume: 50 } }],
  ])('keep the default packets when the request sets %s', (_what, target, options) => {
    const input = writeWav('args-keep.wav', RATE, TWELVE_SECONDS);
    const args = buildFfmpegArguments(input, path.join(workDir, `o.${target}`), 'wav', target, options, ffmpeg());
    expect(packetSizeOf(args)).toBeUndefined();
  });

  it('keep the default packets in the loudness measuring pass and the pass that applies it', () => {
    const input = writeWav('args-loudness.wav', RATE, TWELVE_SECONDS);
    const options: ConversionOptions = { audio: { loudness: { preset: 'podcast' } } };
    const measure = buildLoudnessMeasureArguments(input, 'wav', 'flac', options, ffmpeg());
    expect(measure).toContain('-af');
    expect(packetSizeOf(measure)).toBeUndefined();
    const stage = { kind: 'apply' as const, measurement: { inputI: -20, inputTp: -3, inputLra: 5, inputThresh: -30, targetOffset: 0, sampleRate: RATE } };
    const apply = buildFfmpegArguments(input, path.join(workDir, 'o.flac'), 'wav', 'flac', options, ffmpeg(), undefined, stage);
    expect(apply).toContain('-filter:a');
    expect(packetSizeOf(apply)).toBeUndefined();
  });

  it('keep the default packets where the encoder is given 16 bits from a deeper source, which is dithered', () => {
    const input = writeWav('args-24bit.wav', RATE, TWELVE_SECONDS, BITS_24);
    const args = buildFfmpegArguments(input, path.join(workDir, 'o.wav'), 'wav', 'wav', {}, ffmpeg());
    expect(args).toContain('-filter:a');
    expect(packetSizeOf(args)).toBeUndefined();
    const lossless = buildFfmpegArguments(input, path.join(workDir, 'o24.flac'), 'wav', 'flac', {}, ffmpeg());
    expect(packetSizeOf(lossless)).toBeDefined();
  });

  it('keep the default packets for libopus from 44.1 kHz, which codes 48 kHz and so resamples', () => {
    const input = writeWav('args-opus.wav', RATE, TWELVE_SECONDS);
    const args = buildFfmpegArguments(input, path.join(workDir, 'o.opus'), 'wav', 'opus', {}, ffmpeg());
    expect(args).toContain('-ar');
    expect(packetSizeOf(args)).toBeUndefined();
  });

  it('keep the default packets for a header that does not describe the samples, and for a video target', () => {
    const adpcm = path.join(workDir, 'args-adpcm.wav');
    fs.writeFileSync(adpcm, craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 4, formatTag: 2, data: new Uint8Array(1_000_000) }));
    expect(packetSizeOf(buildFfmpegArguments(adpcm, path.join(workDir, 'o.flac'), 'wav', 'flac', {}, ffmpeg()))).toBeUndefined();
    const video = writeWav('args-video.wav', RATE, TWELVE_SECONDS);
    expect(packetSizeOf(buildFfmpegArguments(video, path.join(workDir, 'o.mp4'), 'wav', 'mp4', { disableHwaccel: true }, ffmpeg()))).toBeUndefined();
  });
});

describe('the encoders write the same file in packets', () => {
  function ffmpeg(): string {
    const found = getOracleToolPath('ffmpeg');
    if (found === null) throw new Error('ffmpeg is not installed');
    return found;
  }

  function run(args: string[]): void {
    execFileSync(ffmpeg(), ['-hide_banner', '-nostdin', '-v', 'error', ...args], { stdio: 'pipe' });
  }

  function withoutPacketSize(args: string[]): string[] {
    const at = args.indexOf('-max_size');
    return [...args.slice(0, at), ...args.slice(at + 2)];
  }

  function decodedSha256(file: string): string {
    return execFileSync(ffmpeg(), ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-'], {
      encoding: 'utf-8',
    }).trim();
  }

  /** The arguments with and without the packet size, built as if the installed ffmpeg were a release the option is used with. */
  function pair(input: string, target: string): { packets: string[]; defaults: string[] } {
    const stub = stubFfmpeg('6.1.1-3ubuntu5');
    const packets = buildFfmpegArguments(input, path.join(workDir, `packets.${target}`), 'wav', target, {}, stub);
    expect(packetSizeOf(packets)).toBeDefined();
    return { packets, defaults: withoutPacketSize(packets).map((arg) => (arg === packets[packets.length - 1] ? path.join(workDir, `default.${target}`) : arg)) };
  }

  /** The block size of a FLAC encode follows the first frame in the newest builds, which the production code does not use the option with. */
  function installedBuildUsesTheOption(): boolean {
    return wavPacketSizeKeepsOutput(probeFfmpegBuild(ffmpeg()).version);
  }

  for (const [bits, target] of [
    [BITS_16, 'flac'],
    [BITS_24, 'flac'],
    [BITS_16, 'aac'],
    [BITS_16, 'mp3'],
  ] as const) {
    oracleTest(
      `${bits}-bit WAVE to ${target}: the file is the one the default packets give, byte for byte`,
      ['ffmpeg'],
      (ctx) => {
        // skip-ok: a build the production code does not use the option with (its FLAC block size follows the first frame) has nothing to compare; the version table above pins that rule.
        if (!installedBuildUsesTheOption()) ctx.skip();
        const input = writeWav(`same-${bits}-${target}.wav`, RATE, 6, bits);
        const { packets, defaults } = pair(input, target);
        run(packets);
        run(defaults);
        expect(fs.readFileSync(packets[packets.length - 1]).equals(fs.readFileSync(defaults[defaults.length - 1]))).toBe(true);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'WAVE to Vorbis in Ogg: the same packets and the same samples (the Ogg stream serial is random)',
    ['ffmpeg'],
    (ctx) => {
      // skip-ok: a build the production code does not use the option with has nothing to compare; the version table above pins that rule.
      if (!installedBuildUsesTheOption()) ctx.skip();
      // skip-ok: libvorbis is an optional encoder (the Ogg target is an engine-unavailable answer without it, policy 54).
      if (!execFileSync(ffmpeg(), ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).includes(' libvorbis ')) ctx.skip();
      const input = writeWav('same-ogg.wav', RATE, 6);
      const { packets, defaults } = pair(input, 'ogg');
      run(packets);
      run(defaults);
      expect(decodedSha256(packets[packets.length - 1])).toBe(decodedSha256(defaults[defaults.length - 1]));
    },
    TEST_TIMEOUT_MS
  );
});
