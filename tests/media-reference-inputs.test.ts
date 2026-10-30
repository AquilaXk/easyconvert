import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertMedia } from '../src/lib/conversions/media';
import { openMediaInput } from '../src/lib/conversions/media-process';
import { RefusedMediaInputError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Uploads that are really playlists or reference lists, under the name of a media container. FFmpeg's probe picks the
 * concat demuxer for any file that opens with `ffconcat version 1.0`, whatever its name, and that demuxer reads the files the
 * list names into the output. A conversion forces the demuxer of the detected format, so these are refused by name and no
 * byte of a file they point at reaches an output.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const CONVERSION_TIMEOUT_MS = 60_000;
const MARKER = 'EASYCONVERT-REFERENCE-MARKER-5b1c';
const MARKER_REPEATS = 2048;
const MARKER_SAMPLE_RATE = 8000;

let markerDir = '';
let markerWav = '';
let markerText = '';

/** A WAVE file whose 16-bit samples spell MARKER, so any output that copies its audio carries the marker's bytes. */
function writeMarkerWave(file: string): void {
  const data = Buffer.from(MARKER.repeat(MARKER_REPEATS).slice(0, (MARKER.length * MARKER_REPEATS) & ~1), 'latin1');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(MARKER_SAMPLE_RATE, 24);
  header.writeUInt32LE(MARKER_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function concatList(...names: string[]): Buffer {
  return Buffer.from(['ffconcat version 1.0', ...names.map((name) => `file '${name}'`), ''].join('\n'));
}

function hlsPlaylist(...uris: string[]): Buffer {
  const segments = uris.flatMap((uri) => ['#EXTINF:1,', uri]);
  return Buffer.from(['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', ...segments, '#EXT-X-ENDLIST', ''].join('\n'));
}

/** The conversion's result: the output bytes, or the error it was refused with. */
async function convert(input: Buffer, src: string, tgt: string): Promise<Buffer | unknown> {
  return convertMedia(input, src, tgt, {}, `upload.${src}`).then((result) => result.buffer, (error: unknown) => error);
}

function expectConverted(outcome: unknown): void {
  expect(outcome).toBeInstanceOf(Buffer);
  expect((outcome as Buffer).length).toBeGreaterThan(0);
}

function carriesMarker(outcome: unknown): boolean {
  return Buffer.isBuffer(outcome) && outcome.includes(MARKER.slice(0, 16), 0, 'latin1');
}

beforeAll(() => {
  // convertMedia writes its input next to os.tmpdir()'s other files, where a relative entry of a list would resolve.
  markerDir = os.tmpdir();
  markerWav = path.join(markerDir, `easyconvert-marker-${process.pid}.wav`);
  markerText = path.join(markerDir, `easyconvert-marker-${process.pid}.txt`);
  writeMarkerWave(markerWav);
  fs.writeFileSync(markerText, `${MARKER}\n`.repeat(MARKER_REPEATS));
});

afterAll(() => {
  fs.rmSync(markerWav, { force: true });
  fs.rmSync(markerText, { force: true });
});

describe.skipIf(skip)('a playlist or reference list uploaded as a media container', () => {
  it('refuses a concat list named .mp4 by name, and its output never holds the file it lists', async () => {
    const outcome = await convert(concatList(path.basename(markerWav)), 'mp4', 'wav');
    expect(carriesMarker(outcome)).toBe(false);
    expect(outcome).toBeInstanceOf(RefusedMediaInputError);
    expect((outcome as RefusedMediaInputError).status).toBe(422);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a concat list named .avi that points at a text file and at an absolute path', async () => {
    const outcome = await convert(concatList(path.basename(markerText), '/etc/passwd'), 'avi', 'mp4');
    expect(carriesMarker(outcome)).toBe(false);
    expect(outcome).toBeInstanceOf(RefusedMediaInputError);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses an HLS playlist named .mp4 that points at file:///etc/passwd and at a local file', async () => {
    const outcome = await convert(hlsPlaylist('file:///etc/passwd', markerWav, path.basename(markerWav)), 'mp4', 'wav');
    expect(carriesMarker(outcome)).toBe(false);
    expect(outcome).toBeInstanceOf(RefusedMediaInputError);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses the same HLS playlist named .avi', async () => {
    const outcome = await convert(hlsPlaylist('file:///etc/passwd', markerWav), 'avi', 'mp3');
    expect(carriesMarker(outcome)).toBe(false);
    expect(outcome).toBeInstanceOf(RefusedMediaInputError);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses the list when the input is opened, so no probe reads what it names', () => {
    const listPath = path.join(markerDir, `easyconvert-list-${process.pid}.mp4`);
    fs.writeFileSync(listPath, concatList(path.basename(markerWav)));
    try {
      expect(() => openMediaInput(listPath, 'mp4')).toThrow(RefusedMediaInputError);
    } finally {
      fs.rmSync(listPath, { force: true });
    }
  });

  it('still converts a real WAVE file whose samples spell the marker', async () => {
    const outcome = await convert(fs.readFileSync(markerWav), 'wav', 'wav');
    expect(carriesMarker(outcome)).toBe(true);
  }, CONVERSION_TIMEOUT_MS);
});

/** A minimal SDP session description: FFmpeg's sdp_probe takes any text with a line that starts `c=IN IP`. */
const SDP_SESSION = 'v=0\no=- 0 0 IN IP4 0.0.0.0\nc=IN IP4 0.0.0.0\nt=0 0';
const DASH_MANIFEST = '<MPD profiles="urn:mpeg:dash:profile:isoff-live:2011"><BaseURL>file:///etc/passwd</BaseURL></MPD>';
const IMF_PLAYLIST = '<CompositionPlaylist><ContentTitle>x</ContentTitle></CompositionPlaylist>';
/** FFmpeg's format probe reads up to 1 MiB (`formatprobesize`); this puts the SDP line past 64 KiB and inside it. */
const DEEP_PADDING_BYTES = 900 * 1024;

describe.skipIf(skip)('manifest text inside a media container, which FFmpeg probes as the container', () => {
  const VIDEO = ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=0.5'];
  const AUDIO = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5'];
  const CONTAINERS: ReadonlyArray<[string, string, string[]]> = [
    ['mp4', 'mkv', [...VIDEO, '-c:v', 'mpeg4', '-f', 'mp4']],
    ['mkv', 'mp4', [...VIDEO, '-c:v', 'mpeg4', '-f', 'matroska']],
    ['mp3', 'wav', [...AUDIO, '-c:a', 'libmp3lame', '-f', 'mp3']],
    ['wav', 'mp3', [...AUDIO, '-f', 'wav']],
    ['ogg', 'wav', [...AUDIO, '-c:a', 'flac', '-f', 'ogg']],
    ['flac', 'wav', [...AUDIO, '-f', 'flac']],
  ];

  it.each(CONTAINERS)('converts a %s whose comment tag holds an SDP session description', async (src, tgt, encoding) => {
    const file = path.join(markerDir, `easyconvert-sdp-tag-${process.pid}.${src}`);
    execFileSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-y', ...encoding, '-metadata', `comment=${SDP_SESSION}`, file]);
    try {
      const bytes = fs.readFileSync(file);
      expect(bytes.includes('c=IN IP4', 0, 'latin1')).toBe(true);
      expectConverted(await convert(bytes, src, tgt));
    } finally {
      fs.rmSync(file, { force: true });
    }
  }, CONVERSION_TIMEOUT_MS);

  it('converts an MP4 whose comment tag holds a DASH manifest', async () => {
    const mp4 = path.join(markerDir, `easyconvert-dash-tag-${process.pid}.mp4`);
    execFileSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-y', ...VIDEO, '-metadata', `comment=${DASH_MANIFEST}`, '-movflags', '+faststart', '-c:v', 'mpeg4', mp4]);
    try {
      expectConverted(await convert(fs.readFileSync(mp4), 'mp4', 'mkv'));
    } finally {
      fs.rmSync(mp4, { force: true });
    }
  }, CONVERSION_TIMEOUT_MS);
});

describe.skipIf(skip)('a manifest or index uploaded as a text file under a media name', () => {
  const deepSdp = `v=0\n${'a=x-pad:000000\n'.repeat(DEEP_PADDING_BYTES / 15)}c=IN IP4 0.0.0.0\nt=0 0\n`;
  const TEXTS: ReadonlyArray<[string, string, string]> = [
    ['an SDP session description', SDP_SESSION, 'SDP session description'],
    ['an SDP session description whose c= line is 900 KiB in', deepSdp, 'SDP session description'],
    ['a DASH manifest', DASH_MANIFEST, 'DASH manifest'],
    ['an IMF composition playlist', IMF_PLAYLIST, 'IMF composition playlist'],
    ['a VobSub index with no version after the comma', '# VobSub index file,v7\nsize: 720x480\n', 'VobSub index'],
  ];

  it.each(TEXTS)('refuses %s named .mp4', async (_, text, kind) => {
    const outcome = await convert(Buffer.from(text, 'latin1'), 'mp4', 'webm');
    expect(outcome).toBeInstanceOf(RefusedMediaInputError);
    expect((outcome as RefusedMediaInputError).kind).toBe(kind);
  }, CONVERSION_TIMEOUT_MS);
});

describe.skipIf(skip)('a media job whose stored input is named by its hash, as the job queue stores it', () => {
  const STORED_ENCODINGS: ReadonlyArray<[string, string[]]> = [
    ['mp3', ['-c:a', 'libmp3lame', '-f', 'mp3']],
    ['wma', ['-c:a', 'wmav2', '-f', 'asf']],
  ];

  it.each(STORED_ENCODINGS)('converts a %s read from <sha256>.bin to WAVE', async (src, encoding) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-stored-input-'));
    try {
      const stored = path.join(dir, `${'5b'.repeat(32)}.bin`);
      const output = path.join(dir, 'out.wav');
      execFileSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...encoding, stored]);
      await dispatchConversion({ inputPath: stored, outputPath: output }, src, 'wav', {}, `song.${src}`);
      const duration = execFileSync(requireOracleTool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output], { encoding: 'utf-8' });
      expect(fs.readFileSync(output).subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(Number(duration)).toBeGreaterThan(0.9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, CONVERSION_TIMEOUT_MS);
});
