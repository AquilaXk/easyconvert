import { describe, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { measureSsimPsnr, probeFile, recordMetric } from './helpers/ffmpeg-measure';
import { convertMedia } from '../src/lib/conversions/media';

/**
 * Encode speed of the AV1 default. SVT-AV1 takes every core, and whether a 10 s 720p clip fits the media timeout
 * depends on how fast the machine is, so this runs with the other performance suites (one file at a time, see
 * .github/workflows/ci.yml) and not beside the correctness shards. The correctness of the AV1 arguments and of the
 * decoded picture at the other defaults stays in media-encoder-defaults.test.ts.
 */

const ENCODE_TIMEOUT_MS = 180_000;
/** AV1 at its default constant-quality setting on a detailed synthetic pattern scores above this against the source (measured 0.96 to 0.99). */
const MODERN_CODEC_MIN_SSIM = 0.95;

function ffmpeg(): string {
  return requireOracleTool('ffmpeg');
}

function withDir<T>(run: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encoder-speed-'));
  return Promise.resolve(run(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function clip(dir: string, size: string, seconds: number): string {
  const out = path.join(dir, `clip_${size}_${seconds}.mp4`);
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', out,
  ]);
  return out;
}

describe('AV1 encode speed at the default preset', () => {
  oracleTest(
    'AV1 is written by SVT-AV1, finishes a 10 s 720p clip inside the media timeout, and matches the source',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libsvtav1', 'libx264');
      await withDir(async (dir) => {
        const source = clip(dir, '1280x720', 10);
        const timeoutMs = 90_000; // computeMediaTimeoutMs(10): 3 * 10 + 60 seconds
        const started = Date.now();
        const result = await convertMedia(fs.readFileSync(source), 'mp4', 'webm', { video: { codec: 'av1' }, timeoutMs }, 'clip.mp4');
        const elapsed = Date.now() - started;
        const out = path.join(dir, 'out.webm');
        fs.writeFileSync(out, result.buffer);
        recordMetric('svt-av1 preset 8 720p 10 s: encode ms', elapsed);
        // convertMedia kills the encode at timeoutMs, so a result means the clip fitted the timeout; the elapsed time is checked as well.
        expect(elapsed).toBeLessThan(timeoutMs);
        const probed = probeFile(requireOracleTool('ffprobe'), out);
        const video = probed.streams.find((s) => s.codec_type === 'video');
        expect(video?.codec_name).toBe('av1');
        expect(video?.tags?.ENCODER ?? probed.format.tags?.ENCODER ?? '').toMatch(/libsvtav1/);
        const measured = measureSsimPsnr(ffmpeg(), out, source);
        recordMetric('svt-av1 preset 8 720p 10 s: ssim', measured.ssim);
        expect(measured.ssim).toBeGreaterThanOrEqual(MODERN_CODEC_MIN_SSIM);
      });
    },
    ENCODE_TIMEOUT_MS
  );

});
