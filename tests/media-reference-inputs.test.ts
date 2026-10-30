import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertMedia, getFfprobePath } from '../src/lib/conversions/media';
import { type FfprobePath, probeInput, resetInputProbeCache } from '../src/lib/conversions/media-ffprobe';
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

  it('refuses the list in ffprobe too, before a probe reads what it names', () => {
    const listPath = path.join(markerDir, `easyconvert-list-${process.pid}.mp4`);
    fs.writeFileSync(listPath, concatList(path.basename(markerWav)));
    resetInputProbeCache();
    try {
      expect(() => probeInput(listPath, getFfprobePath() as FfprobePath)).toThrow(RefusedMediaInputError);
    } finally {
      fs.rmSync(listPath, { force: true });
    }
  });

  it('refuses a real MP4 whose first bytes also hold a DASH manifest, which the subtitle burn filter would probe as one', async () => {
    const mp4 = path.join(markerDir, `easyconvert-dash-tag-${process.pid}.mp4`);
    execFileSync(requireOracleTool('ffmpeg'), [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=0.5',
      '-metadata', 'comment=<MPD profiles="urn:mpeg:dash:profile:isoff-live:2011"><BaseURL>file:///etc/passwd</BaseURL></MPD>',
      '-movflags', '+faststart', '-c:v', 'mpeg4', mp4,
    ]);
    try {
      expect(fs.readFileSync(mp4).subarray(0, 64 * 1024).includes('<MPD')).toBe(true);
      const outcome = await convert(fs.readFileSync(mp4), 'mp4', 'webm');
      expect(outcome).toBeInstanceOf(RefusedMediaInputError);
      expect((outcome as RefusedMediaInputError).kind).toBe('DASH manifest');
    } finally {
      fs.rmSync(mp4, { force: true });
    }
  }, CONVERSION_TIMEOUT_MS);

  it('still converts a real WAVE file whose samples spell the marker', async () => {
    const outcome = await convert(fs.readFileSync(markerWav), 'wav', 'wav');
    expect(carriesMarker(outcome)).toBe(true);
  }, CONVERSION_TIMEOUT_MS);
});
