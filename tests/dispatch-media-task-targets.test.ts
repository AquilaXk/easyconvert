import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { UnsupportedTargetError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { skipWithoutTools } from './helpers/strict-skip';

const FFMPEG = getOracleToolPath('ffmpeg');
const SKIP_WITHOUT_FFMPEG = skipWithoutTools('ffmpeg');
const SAMPLE_MP4 = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.mp4'));
const CONVERT_TIMEOUT_MS = 120_000;
const SUBTITLE_TEXT = 'Hello dispatch subtitles';
const SRT_SOURCE = `1\n00:00:00,100 --> 00:00:00,900\n${SUBTITLE_TEXT}\n\n`;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const THUMBNAIL_OFFSET = '00:00:00.500';

let workDir = '';
let mkvWithSubtitles = Buffer.alloc(0);
let decodableMp4 = Buffer.alloc(0);

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'dispatch-media-targets-'));
  if (!FFMPEG) return;
  const srtPath = path.join(workDir, 'sub.srt');
  const mkvPath = path.join(workDir, 'with-subs.mkv');
  writeFileSync(srtPath, SRT_SOURCE);
  execFileSync(
    FFMPEG,
    ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=1', '-i', srtPath, '-map', '0:v', '-map', '1:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:s', 'srt', mkvPath],
    { stdio: 'ignore' }
  );
  mkvWithSubtitles = readFileSync(mkvPath);
  const mp4Path = path.join(workDir, 'decodable.mp4');
  execFileSync(
    FFMPEG,
    ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4Path],
    { stdio: 'ignore' }
  );
  decodableMp4 = readFileSync(mp4Path);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('task-driven media targets the registry does not list', () => {
  it('rejects a plain mp4 to jpg request without the thumbnail option', async () => {
    const run = dispatchConversion(SAMPLE_MP4, 'mp4', 'jpg', {}, 'sample.mp4');
    await expect(run).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(run).rejects.toThrow(/^Unsupported conversion from \.mp4 to \.jpg/);
  });

  it('rejects a plain mp4 to hls request without the packaging option', async () => {
    const run = dispatchConversion(SAMPLE_MP4, 'mp4', 'hls', {}, 'sample.mp4');
    await expect(run).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(run).rejects.toThrow(/^Unsupported conversion from \.mp4 to \.hls/);
  });

  it('rejects mkv to srt unless the subtitle mode is extract', async () => {
    const plain = dispatchConversion(SAMPLE_MP4, 'mkv', 'srt', {}, 'in.mkv');
    await expect(plain).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(plain).rejects.toThrow(/^Unsupported conversion from \.mkv to \.srt/);
    const soft = dispatchConversion(SAMPLE_MP4, 'mkv', 'srt', { subtitles: { mode: 'soft', input: 'x.srt' } }, 'in.mkv');
    await expect(soft).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(soft).rejects.toThrow(/^Unsupported conversion from \.mkv to \.srt/);
  });

  it('does not let a thumbnail option open an unrelated target', async () => {
    const run = dispatchConversion(SAMPLE_MP4, 'mp4', 'docx', { thumbnail: { at: [THUMBNAIL_OFFSET] } }, 'sample.mp4');
    await expect(run).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(run).rejects.toThrow(/^Unsupported conversion from \.mp4 to \.docx/);
  });

  it.skipIf(SKIP_WITHOUT_FFMPEG)(
    'extracts a jpg thumbnail from a video when the thumbnail option is present (needs ffmpeg)',
    async () => {
      const result = await dispatchConversion(decodableMp4, 'mp4', 'jpg', { thumbnail: { at: [THUMBNAIL_OFFSET] } }, 'sample.mp4');
      expect(result.engineUsed).toBe('native-ffmpeg');
      expect(result.buffer.subarray(0, JPEG_MAGIC.length)).toEqual(JPEG_MAGIC);
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeGreaterThan(0);
    },
    CONVERT_TIMEOUT_MS
  );

  it.skipIf(SKIP_WITHOUT_FFMPEG)(
    'extracts a png thumbnail from a video when the thumbnail option is present (needs ffmpeg)',
    async () => {
      const result = await dispatchConversion(decodableMp4, 'mp4', 'png', { thumbnail: { at: [THUMBNAIL_OFFSET] } }, 'sample.mp4');
      expect(result.buffer.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
      expect((await sharp(result.buffer).metadata()).format).toBe('png');
    },
    CONVERT_TIMEOUT_MS
  );

  it.skipIf(SKIP_WITHOUT_FFMPEG)(
    'packages a video to HLS when the packaging option is present (needs ffmpeg)',
    async () => {
      const result = await dispatchConversion(decodableMp4, 'mp4', 'hls', { packaging: { format: 'hls', segmentSeconds: 2 } }, 'sample.mp4');
      const zip = await JSZip.loadAsync(result.buffer);
      const playlistName = Object.keys(zip.files).find((name) => name.endsWith('.m3u8'));
      expect(playlistName).toBeDefined();
      const playlist = await zip.files[playlistName as string].async('text');
      expect(playlist.startsWith('#EXTM3U')).toBe(true);
    },
    CONVERT_TIMEOUT_MS
  );

  it.skipIf(SKIP_WITHOUT_FFMPEG)(
    'extracts a subtitle stream from mkv to srt and vtt in extract mode (needs ffmpeg)',
    async () => {
      const srt = await dispatchConversion(mkvWithSubtitles, 'mkv', 'srt', { subtitles: { mode: 'extract', streamIndex: 0 } }, 'in.mkv');
      expect(srt.buffer.toString('utf-8')).toContain(SUBTITLE_TEXT);
      const vtt = await dispatchConversion(mkvWithSubtitles, 'mkv', 'vtt', { subtitles: { mode: 'extract', streamIndex: 0 } }, 'in.mkv');
      expect(vtt.buffer.toString('utf-8').startsWith('WEBVTT')).toBe(true);
      expect(vtt.buffer.toString('utf-8')).toContain(SUBTITLE_TEXT);
    },
    CONVERT_TIMEOUT_MS
  );
});
