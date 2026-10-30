import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { buildFfmpegArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { computeMediaTimeoutMs } from '../src/lib/conversions/media-job-limit';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { decodeEveryStream, measureSsimPsnr, probeFile, recordMetric } from './helpers/ffmpeg-measure';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';
import { HAS_ZSCALE } from './helpers/zimg-oracle';
import { openMediaInput } from '../src/lib/conversions/media-process';

/**
 * The HDR10 clip of the real-world corpus (30 s, 1080p, 60 fps, HEVC Main 10) to WebM. At the good deadline the encode
 * took 80 s on four idle cores and ran into the 150 s media limit when three jobs shared them (the nightly real-file
 * run). The conversion now finishes in under half of the limit on a quiet machine, with every frame, the SDR colour
 * tags of the tone-mapped picture and a picture that stays within SSIM 0.99 of the lossless tone-mapped frames.
 * Timing suites run one file at a time (see .github/workflows/nightly.yml).
 */

const SAMPLE = 'jellyfin-1080p-hevc-hdr10-3m.mp4';
const TEST_TIMEOUT_MS = 600_000;
const SOURCE_FRAMES = 1797;
const SOURCE_SECONDS = 29.95;
/** The finished encode uses at most this share of the job limit; the measured time on four idle cores is a fifth. */
const MAX_SHARE_OF_LIMIT = 0.5;
/** Measured 0.9959 at the realtime deadline and 0.9968 at the good one. */
const MIN_SSIM = 0.99;

function ffmpeg(): string {
  return requireOracleTool('ffmpeg');
}

function counted(file: string): number {
  const out = execFileSync(
    requireOracleTool('ffprobe'),
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  return Number(out.trim());
}

describe.skipIf(skipUnless('ffmpeg with zscale and lutrgb', HAS_ZSCALE))('HDR10 video to WebM', () => {
  oracleTest(
    'the real 1080p60 clip finishes inside half of the job limit, with all its frames, SDR tags and a picture close to the lossless tone-mapped one',
    ['ffmpeg', 'ffprobe'],
    async (ctx) => {
      requireEncoders('libvpx-vp9');
      const sample = await requireRealworldSample(ctx, SAMPLE);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-webm-speed-'));
      try {
        const started = Date.now();
        const result = await dispatchConversion(sample.bytes, 'mp4', 'webm', {}, 'hdr.mp4');
        const elapsedMs = Date.now() - started;
        const out = path.join(dir, 'out.webm');
        fs.writeFileSync(out, result.buffer);
        recordMetric('hdr10 1080p60 30 s to webm: convert ms', elapsedMs);
        recordMetric('hdr10 1080p60 30 s to webm: output bytes', result.buffer.length);
        expect(elapsedMs).toBeLessThan(computeMediaTimeoutMs(SOURCE_SECONDS) * MAX_SHARE_OF_LIMIT);

        const video = probeFile(requireOracleTool('ffprobe'), out).streams.find((stream) => stream.codec_type === 'video');
        expect(video).toMatchObject({ codec_name: 'vp9', width: 1920, height: 1080, pix_fmt: 'yuv420p' });
        const colour = JSON.parse(
          execFileSync(requireOracleTool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,color_space,color_transfer,color_primaries', '-of', 'json', out], { encoding: 'utf8' })
        ) as { streams: Array<Record<string, string>> };
        expect(colour.streams[0]).toEqual({ color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' });
        expect(counted(sample.path)).toBe(SOURCE_FRAMES);
        expect(counted(out)).toBe(SOURCE_FRAMES);
        decodeEveryStream(ffmpeg(), out);

        // The lossless tone-mapped frames: the filter chain of the conversion written to FFV1, so that the score
        // below judges the encoder alone.
        const args = buildFfmpegArguments(openMediaInput(sample.path, 'mp4'), path.join(dir, 'unused.webm'), 'webm', { disableHwaccel: true }, ffmpeg());
        const filter = args[args.indexOf('-vf') + 1];
        const reference = path.join(dir, 'reference.mkv');
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', sample.path, '-vf', filter, '-pix_fmt', 'yuv420p', '-an', '-c:v', 'ffv1', reference], { stdio: ['ignore', 'ignore', 'pipe'] });
        const measured = measureSsimPsnr(ffmpeg(), out, reference);
        recordMetric('hdr10 1080p60 30 s to webm: ssim', measured.ssim);
        expect(measured.ssim).toBeGreaterThanOrEqual(MIN_SSIM);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
