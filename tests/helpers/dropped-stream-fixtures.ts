import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';
import { requireEncoders } from './ffmpeg-media-fixtures';
import { probeFile, type ProbedStream } from './ffmpeg-measure';

/**
 * Media-library shaped clips authored with the reference ffmpeg, and the list of streams a target container
 * cannot carry as the reference ffprobe sees it (the oracle for the `droppedStreams` result field).
 */

export const FIXTURE_WIDTH = 320;
export const FIXTURE_HEIGHT = 180;
export const FIXTURE_FPS = 25;
export const FIXTURE_SECONDS = 3;
export const FIXTURE_FRAMES = FIXTURE_FPS * FIXTURE_SECONDS;
export const FIXTURE_SAMPLE_RATE = 44100;
const FIXTURE_ENCODE_TIMEOUT_MS = 120_000;
const TONE_HZ = 440;
const COVER_SIZE = 64;

export const FIXTURE_CHAPTERS = [
  { startMs: 0, endMs: 1000, title: 'Intro' },
  { startMs: 1000, endMs: 2000, title: 'Middle' },
  { startMs: 2000, endMs: 3000, title: 'Outro' },
];

export interface ExpectedDrop {
  index?: number;
  kind: string;
  codec?: string;
  language?: string;
  title?: string;
  reason: string;
}

function run(args: string[]): void {
  execFileSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: FIXTURE_ENCODE_TIMEOUT_MS,
  });
}

export function withFixtureDir<T>(body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropped-streams-'));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function withFixtureDirAsync<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropped-streams-'));
  try {
    return await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const videoInput = ['-f', 'lavfi', '-i', `testsrc2=size=${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}:rate=${FIXTURE_FPS}:duration=${FIXTURE_SECONDS}`];
const audioInput = ['-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=${FIXTURE_SAMPLE_RATE}:duration=${FIXTURE_SECONDS}`];
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FIXTURE_FPS)];

/**
 * An mkv with one H.264 video, one PCM audio track (eng, "English"), two SubRip tracks (eng and kor, the first
 * titled) and one attachment; with `chapters`, three chapters as well. The audio is PCM so the container
 * starts at zero and no chapter is moved by an encoder delay.
 */
export function libraryMkv(dir: string, options: { chapters?: boolean } = {}): Buffer {
  requireEncoders('libx264');
  fs.writeFileSync(path.join(dir, 'notes.bin'), Buffer.from('attachment payload'));
  fs.writeFileSync(path.join(dir, 'eng.srt'), '1\n00:00:00,500 --> 00:00:02,500\nHello English\n\n');
  fs.writeFileSync(path.join(dir, 'kor.srt'), '1\n00:00:00,500 --> 00:00:02,500\nHello Korean\n\n');
  const meta = [
    ';FFMETADATA1',
    ...(options.chapters
      ? FIXTURE_CHAPTERS.flatMap((c) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${c.startMs}`, `END=${c.endMs}`, `title=${c.title}`])
      : []),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'meta.txt'), meta);
  const out = path.join(dir, 'library.mkv');
  run([
    ...videoInput,
    ...audioInput,
    '-i', path.join(dir, 'eng.srt'), '-i', path.join(dir, 'kor.srt'), '-i', path.join(dir, 'meta.txt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
    '-map_metadata', '4', '-map_chapters', options.chapters ? '4' : '-1',
    ...H264, '-c:a', 'pcm_s16le', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English cues', '-metadata:s:s:1', 'language=kor',
    '-attach', path.join(dir, 'notes.bin'), '-metadata:s:t:0', 'mimetype=application/octet-stream',
    out,
  ]);
  return fs.readFileSync(out);
}

/** An mkv with the same chapters whose audio is AAC: its encoder delay puts the container start before zero. */
export function aacChapterMkv(dir: string): Buffer {
  requireEncoders('libx264', 'aac');
  const meta = [
    ';FFMETADATA1',
    ...FIXTURE_CHAPTERS.flatMap((c) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${c.startMs}`, `END=${c.endMs}`, `title=${c.title}`]),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'aac-meta.txt'), meta);
  const out = path.join(dir, 'aac-chapters.mkv');
  run([
    ...videoInput, ...audioInput, '-i', path.join(dir, 'aac-meta.txt'),
    '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2',
    ...H264, '-c:a', 'aac', '-b:a', '64k',
    out,
  ]);
  return fs.readFileSync(out);
}

/** An mp4 with two video tracks: the picture and a second, smaller one. */
export function twoVideoTrackMp4(dir: string): Buffer {
  requireEncoders('libx264');
  const out = path.join(dir, 'two-video.mp4');
  run([
    ...videoInput,
    '-f', 'lavfi', '-i', `testsrc=size=${FIXTURE_WIDTH / 2}x${FIXTURE_HEIGHT / 2}:rate=${FIXTURE_FPS}:duration=${FIXTURE_SECONDS}`,
    ...audioInput,
    '-map', '0:v', '-map', '1:v', '-map', '2:a',
    ...H264, '-c:a', 'aac',
    out,
  ]);
  return fs.readFileSync(out);
}

/** An mp4 with a picture track, audio and an attached cover picture. */
export function coverArtMp4(dir: string): Buffer {
  requireEncoders('libx264', 'mjpeg');
  const cover = path.join(dir, 'cover.jpg');
  run(['-f', 'lavfi', '-i', `testsrc=size=${COVER_SIZE}x${COVER_SIZE}:duration=1`, '-frames:v', '1', cover]);
  const out = path.join(dir, 'cover.mp4');
  run([
    ...videoInput, ...audioInput, '-i', cover,
    '-map', '0:v', '-map', '1:a', '-map', '2:v',
    ...H264, '-c:a', 'aac', '-c:v:1', 'copy', '-disposition:v:1', 'attached_pic',
    out,
  ]);
  return fs.readFileSync(out);
}

/** A mov with a timecode data track next to the picture and audio. */
export function timecodeMov(dir: string): Buffer {
  requireEncoders('libx264');
  const out = path.join(dir, 'timecode.mov');
  run([...videoInput, ...audioInput, ...H264, '-c:a', 'aac', '-timecode', '01:00:00:00', out]);
  return fs.readFileSync(out);
}

export function probeBuffer(bytes: Buffer, extension: string): ReturnType<typeof probeFile> {
  return withFixtureDir((dir) => {
    const file = path.join(dir, `probe.${extension}`);
    fs.writeFileSync(file, bytes);
    return probeFile(requireOracleTool('ffprobe'), file);
  });
}

/** The entry the reference ffprobe's view of `stream` must produce when it is dropped. */
export function expectedDrop(stream: ProbedStream, kind: string, reason: string): ExpectedDrop {
  const entry: ExpectedDrop = { index: stream.index, kind, reason };
  if (stream.codec_name) entry.codec = stream.codec_name;
  if (stream.tags?.language) entry.language = stream.tags.language;
  if (stream.tags?.title) entry.title = stream.tags.title;
  return entry;
}
