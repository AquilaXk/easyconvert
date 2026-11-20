import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { convertMedia } from '../src/lib/conversions/media';
import { buildFfmpegArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { openMediaInput } from '../src/lib/conversions/media-process';

/**
 * The bitrate written when a request names none. The reference converter's defaults come from its formats listing: MP3 is
 * written at LAME VBR scale 0, AAC, M4A and WMA at 128 kbit/s. A fixed 192 kbit/s wrote a 16 kHz mono recording at 161 kbit/s
 * (157 KB for 8 s where the other converters write 24 KB). Opus keeps 128 kbit/s for two or more channels and writes a mono
 * track at the encoder's own 64 kbit/s.
 */

const FFMPEG_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;
const SECONDS = 4;
const MONO_RATE_HZ = 16000;
const STEREO_RATE_HZ = 44100;
/** The fixed rate MPEG-2 Layer III reaches at 16 kHz; a source that is a plain tone needs a fraction of it. */
const CONSTANT_RATE_KBPS = 160;
const BITS_PER_KILOBIT = 1000;
const BITS_PER_BYTE = 8;

let workDir: string;

function ffmpeg(args: string[]): void {
  execFileSync(getOracleToolPath('ffmpeg')!, ['-v', 'error', '-y', ...args], { stdio: 'ignore', timeout: FFMPEG_TIMEOUT_MS });
}

function wavOf(name: string, rate: number, channels: number): string {
  const file = path.join(workDir, name);
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${SECONDS}`, '-ac', String(channels), file]);
  return file;
}

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function build(file: string, source: string, target: string, options = {}): Promise<string[]> {
  return await buildFfmpegArguments(openMediaInput(file, source), `/tmp/o.${target}`, target, options);
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-audio-default-rates-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('default bitrate of the lossy audio targets', () => {
  it('writes MP3 at LAME VBR scale 0 and keeps a requested bitrate constant', async () => {
    const absent = '/nonexistent/in.wav';
    const implicit = await build(absent, 'wav', 'mp3');
    expect(argAfter(implicit, '-q:a')).toBe('0');
    expect(implicit).not.toContain('-b:a');
    for (const options of [{ audio: { bitrateK: 128 } }, { audioBitrate: '128k' }]) {
      const requested = await build(absent, 'wav', 'mp3', options);
      expect(argAfter(requested, '-b:a')).toBe('128k');
      expect(requested).not.toContain('-q:a');
    }
  });

  it('writes AAC, M4A, M4B and WMA at the reference 128 kbit/s and AC-3 at 192 kbit/s', async () => {
    for (const id of ['aac', 'm4a', 'm4b', 'wma']) {
      expect(argAfter(await build('/nonexistent/in.wav', 'wav', id), '-b:a')).toBe('128k');
    }
    expect(argAfter(await build('/nonexistent/in.wav', 'wav', 'ac3'), '-b:a')).toBe('192k');
  });

  oracleTest('a 16 kHz mono WAV becomes an MP3 well under the constant rate of the old default', ['ffmpeg', 'ffprobe'], async () => {
    const source = wavOf('mono-16k.wav', MONO_RATE_HZ, 1);
    const result = await convertMedia(fs.readFileSync(source), 'wav', 'mp3', {}, 'tone.wav');
    const kbps = (result.buffer.length * BITS_PER_BYTE) / SECONDS / BITS_PER_KILOBIT;
    expect(kbps).toBeLessThan(CONSTANT_RATE_KBPS / 2);
  }, TEST_TIMEOUT_MS);
});

describe('default Opus bitrate follows the channel count of the track', () => {
  oracleTest('a mono track is written at 64 kbit/s and a stereo one at 128 kbit/s, to every Opus target', ['ffmpeg', 'ffprobe'], async () => {
    const mono = wavOf('mono.wav', MONO_RATE_HZ, 1);
    const stereo = wavOf('stereo.wav', STEREO_RATE_HZ, 2);
    for (const id of ['opus', 'weba']) {
      expect(argAfter(await build(mono, 'wav', id), '-b:a')).toBe('64k');
      expect(argAfter(await build(stereo, 'wav', id), '-b:a')).toBe('128k');
    }
    const monoVideo = path.join(workDir, 'mono.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=1', '-i', mono, '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', monoVideo]);
    expect(argAfter(await build(monoVideo, 'mp4', 'webm'), '-b:a')).toBe('64k');
    const stereoVideo = path.join(workDir, 'stereo.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=1', '-i', stereo, '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', stereoVideo]);
    expect(argAfter(await build(stereoVideo, 'mp4', 'webm'), '-b:a')).toBe('128k');
  }, TEST_TIMEOUT_MS);

  oracleTest('a mono track beside a stereo track keeps 128 kbit/s: the rate is one for every track written', ['ffmpeg', 'ffprobe'], async () => {
    const mono = wavOf('mono-two.wav', MONO_RATE_HZ, 1);
    const stereo = wavOf('stereo-two.wav', STEREO_RATE_HZ, 2);
    const twoTracks = path.join(workDir, 'two-tracks.mkv');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=1', '-i', mono, '-i', stereo, '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', twoTracks]);
    expect(argAfter(await build(twoTracks, 'mkv', 'webm'), '-b:a')).toBe('128k');
  }, TEST_TIMEOUT_MS);

  oracleTest('a requested bitrate or channel count wins over the mono default', ['ffmpeg', 'ffprobe'], async () => {
    const mono = wavOf('mono-requested.wav', MONO_RATE_HZ, 1);
    expect(argAfter(await build(mono, 'wav', 'opus', { audio: { bitrateK: 96 } }), '-b:a')).toBe('96k');
    expect(argAfter(await build(mono, 'wav', 'opus', { audio: { channels: 2 } }), '-b:a')).toBe('128k');
  }, TEST_TIMEOUT_MS);

  it('keeps 128 kbit/s when the input cannot be probed', async () => {
    expect(argAfter(await build('/nonexistent/in.wav', 'wav', 'opus'), '-b:a')).toBe('128k');
  });
});
