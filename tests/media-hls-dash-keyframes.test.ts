import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { measureSsimPsnr, recordMetric } from './helpers/ffmpeg-measure';
import {
  containerDuration,
  extractZipToTemp,
  firstSliceNalType,
  firstVideoPacket,
  parseMasterPlaylist,
  parseMediaPlaylist,
  parseMpd,
  videoFrameRates,
} from './helpers/abr-oracle';
import { buildHlsDashArguments, type PackagingSource } from '../src/lib/conversions/media-ffmpeg-args';
import { capLadderToSource, keyframeIntervalFrames, rungRateCaps } from '../src/lib/conversions/media-packaging';
import { computePackagingTimeoutMs, packageHlsDashMedia } from '../src/lib/conversions/media';
import { InvalidMediaOptionError, NoVideoStreamError } from '../src/lib/types';
import { probeVideoGeometry, resolveFfprobeBinary } from '../src/lib/conversions/media-ffprobe';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { validateOrProblem } from '../src/lib/api/contracts/validate';

/**
 * HLS and DASH packaging must cut every rung at the same instants, on IDR frames, whatever the source
 * frame rate (RFC 8216 section 6.2.3: renditions switch at segment boundaries). The oracles are ffprobe
 * packets, ffmpeg's NAL trace and playlist/MPD parsers written in tests/helpers/abr-oracle.ts.
 */

const SEGMENT_SECONDS = 4;
const CLIP_SECONDS = 12;
const SEGMENTS_IN_CLIP = CLIP_SECONDS / SEGMENT_SECONDS;
/** Segment length may deviate from the target by this much (one frame at 24 fps is 0.042 s); the last segment is exempt. */
const SEGMENT_DURATION_TOLERANCE_SEC = 0.1;
/** The MPEG-TS clock runs at 90 kHz; two rungs must start a segment on the same tick, give or take one. */
const TS_TICK_SEC = 1 / 90_000;
const PTS_TOLERANCE_SEC = TS_TICK_SEC * 1.01;
/** HLS authoring guidance: a segment's peak rate stays within 10% of the BANDWIDTH the master playlist declares. */
const PEAK_OVER_BANDWIDTH_MAX = 1.1;
/** Packaged video against the source it was cut from, both 8-bit 4:2:0; the rung is a second generation encode at a capped rate. */
const PACKAGED_MIN_SSIM = 0.95;
const H264_IDR_NAL_TYPE = 5;
const HEVC_IDR_NAL_TYPES = new Set([19, 20]);
const ENCODE_TIMEOUT_MS = 180_000;

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 360;

function ffmpeg(): string {
  return requireOracleTool('ffmpeg');
}

function makeSource(rate: string, seconds = CLIP_SECONDS, extra: string[] = [], size = `${SOURCE_WIDTH}x${SOURCE_HEIGHT}`): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-source-'));
  try {
    const out = path.join(dir, 'source.mp4');
    execFileSync(ffmpeg(), [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...extra, out,
    ]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function geometry(over: Partial<PackagingSource['geometry']> = {}): PackagingSource {
  return {
    geometry: { fpsNum: 25, fpsDen: 1, width: 1920, height: 1080, durationSec: 60, ...over },
    hasAudio: true,
  };
}

describe('segment planning (pure)', () => {
  it('uses the exact rational frame rate for the keyframe interval, never 30 fps', () => {
    expect(keyframeIntervalFrames(24, 1, 4)).toBe(96);
    expect(keyframeIntervalFrames(25, 1, 4)).toBe(100);
    expect(keyframeIntervalFrames(30000, 1001, 4)).toBe(120);
    expect(keyframeIntervalFrames(60, 1, 4)).toBe(240);
    // 24 fps x 6 s is 144 frames; at 23.976 fps a 6 s segment holds 143.86 frames and the GOP must not be shorter.
    expect(keyframeIntervalFrames(24000, 1001, 6)).toBe(144);
  });

  it('emits GOP, forced keyframes, scene-cut off and equal min/max keyint on every rung', () => {
    const args = buildHlsDashArguments(
      '/tmp/in.mp4',
      '/tmp/out',
      { format: 'hls', segmentSeconds: 4, ladder: [{ height: 720, bitrateK: 2500 }, { height: 360, bitrateK: 800 }] },
      null,
      geometry({ fpsNum: 30000, fpsDen: 1001 })
    );
    for (const rung of [0, 1]) {
      expect(args[args.indexOf(`-g:v:${rung}`) + 1]).toBe('120');
      expect(args[args.indexOf(`-keyint_min:v:${rung}`) + 1]).toBe('120');
      expect(args[args.indexOf(`-sc_threshold:v:${rung}`) + 1]).toBe('0');
      expect(args[args.indexOf(`-forced-idr:v:${rung}`) + 1]).toBe('1');
      expect(args[args.indexOf(`-force_key_frames:v:${rung}`) + 1]).toBe('expr:gte(t,n_forced*4)');
      expect(args[args.indexOf(`-pix_fmt:v:${rung}`) + 1]).toBe('yuv420p');
    }
  });

  it('caps each rung at 1.07x the declared rate with a 1.5x buffer', () => {
    expect(rungRateCaps(2500)).toEqual({ maxrateK: 2675, bufsizeK: 3750 });
    const args = buildHlsDashArguments(
      '/tmp/in.mp4',
      '/tmp/out',
      { format: 'hls', ladder: [{ height: 720, bitrateK: 2500 }] },
      null,
      geometry()
    );
    expect(args[args.indexOf('-b:v:0') + 1]).toBe('2500k');
    expect(args[args.indexOf('-maxrate:v:0') + 1]).toBe('2675k');
    expect(args[args.indexOf('-bufsize:v:0') + 1]).toBe('3750k');
  });

  it('drops rungs taller than the source and keeps one at the source height when none fits', () => {
    const ladder = [
      { height: 1080, bitrateK: 4500 },
      { height: 720, bitrateK: 2500 },
      { height: 480, bitrateK: 1000 },
    ];
    expect(capLadderToSource(ladder, geometry({ height: 480 }).geometry).map((r) => r.height)).toEqual([480]);
    expect(capLadderToSource(ladder, geometry({ height: 720 }).geometry).map((r) => r.height)).toEqual([720, 480]);
    expect(capLadderToSource(ladder, geometry({ height: 1080 }).geometry).map((r) => r.height)).toEqual([1080, 720, 480]);
    const none = capLadderToSource(ladder, geometry({ height: 360 }).geometry);
    expect(none).toEqual([{ height: 360, bitrateK: 1000 }]);
    // An odd source height rounds down: 4:2:0 needs an even size.
    expect(capLadderToSource(ladder, geometry({ height: 361 }).geometry)[0].height).toBe(360);
  });

  it('never asks a rung for more bitrate than the source carries', () => {
    const capped = capLadderToSource(
      [{ height: 720, bitrateK: 2500 }, { height: 360, bitrateK: 800 }],
      geometry({ height: 1080, bitrateK: 1200 }).geometry
    );
    expect(capped.map((r) => r.bitrateK)).toEqual([1200, 800]);
  });

  it('plans an input of 480 px height as a single 480p rung in the arguments', () => {
    const args = buildHlsDashArguments(
      '/tmp/in.mp4',
      '/tmp/out',
      { format: 'hls' },
      null,
      geometry({ width: 854, height: 480 })
    );
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0,name:480p');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[v_in0]scale=w=-2:h=480[v_out0]');
    expect(args).not.toContain('-c:v:1');
  });

  it('tags HEVC as hvc1 and switches HLS to fMP4 segments with an init section on request', () => {
    const args = buildHlsDashArguments(
      '/tmp/in.mp4',
      '/tmp/out',
      { format: 'hls', videoCodec: 'hevc', segmentType: 'fmp4', ladder: [{ height: 360, bitrateK: 800 }] },
      null,
      geometry({ height: 360 })
    );
    expect(args[args.indexOf('-tag:v:0') + 1]).toBe('hvc1');
    expect(args[args.indexOf('-hls_segment_type') + 1]).toBe('fmp4');
    expect(args[args.indexOf('-hls_segment_filename') + 1]).toBe(path.join('/tmp/out', 'stream_%v_%03d.m4s'));
    expect(args[args.indexOf('-x265-params:v:0') + 1]).toBe('scenecut=0:open-gop=0');
  });

  it('rejects an unknown segmentType, TS for DASH, odd and duplicate rung heights', () => {
    const build = (packaging: object) => () =>
      buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', packaging as never, null, geometry());
    expect(build({ format: 'hls', segmentType: 'mp4' })).toThrow(InvalidMediaOptionError);
    expect(build({ format: 'dash', segmentType: 'ts' })).toThrow(InvalidMediaOptionError);
    expect(build({ format: 'hls', ladder: [{ height: 481, bitrateK: 1000 }] })).toThrow(/even height/);
    expect(build({ format: 'hls', ladder: [{ height: 480, bitrateK: 1000 }, { height: 480, bitrateK: 900 }] })).toThrow(/Duplicate/);
  });

  it('scales the timeout with the clip duration and the rung count, under the tier ceiling', () => {
    // A 10 minute clip on a 3 rung ladder must get more than the old fixed 120 s.
    expect(computePackagingTimeoutMs(600, 3)).toBeGreaterThan(120_000);
    expect(computePackagingTimeoutMs(600, 3)).toBe(180_000);
    expect(computePackagingTimeoutMs(600, 3, 900_000)).toBe(900_000);
    // 10 s of clip: one rung is (3 * 10 + 60) s, three rungs (3 * 30 + 60) s, both under the ceiling.
    expect(computePackagingTimeoutMs(10, 1)).toBe(90_000);
    expect(computePackagingTimeoutMs(10, 3)).toBe(150_000);
    expect(computePackagingTimeoutMs(0, 3)).toBe(60_000);
  });
});

describe('request schema', () => {
  it('accepts segmentType ts and fmp4 and answers 422 for any other value', () => {
    for (const segmentType of ['ts', 'fmp4']) {
      expect(validateOrProblem(ConversionOptionsSchema, { packaging: { format: 'hls', segmentType } }).ok, segmentType).toBe(true);
    }
    const bad = validateOrProblem(ConversionOptionsSchema, { packaging: { format: 'hls', segmentType: 'cmaf' } });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('schema accepted segmentType cmaf');
    expect(bad.problem.status).toBe(422);
    expect(bad.problem.invalidParams?.map((p) => p.name)).toEqual(['packaging.segmentType']);
  });
});

interface PackagedRung {
  name: string;
  playlist: ReturnType<typeof parseMediaPlaylist>;
  bandwidth: number;
}

async function packageHls(
  source: Buffer,
  packaging: Record<string, unknown>
): Promise<{ dir: string; rungs: PackagedRung[]; master: ReturnType<typeof parseMasterPlaylist> }> {
  const result = await packageHlsDashMedia(source, 'mp4', { packaging: { format: 'hls', ...packaging } as never }, 'clip');
  const dir = await extractZipToTemp(result.buffer);
  const master = parseMasterPlaylist(fs.readFileSync(path.join(dir, 'master.m3u8'), 'utf8'));
  const rungs = master.map((variant) => ({
    name: variant.uri.replace(/^stream_|\.m3u8$/g, ''),
    playlist: parseMediaPlaylist(fs.readFileSync(path.join(dir, variant.uri), 'utf8')),
    bandwidth: variant.bandwidth,
  }));
  return { dir, rungs, master };
}

const SOURCE_RATES: Array<{ label: string; rate: string; avg: string; fps: number }> = [
  { label: '24 fps', rate: '24', avg: '24/1', fps: 24 },
  { label: '25 fps', rate: '25', avg: '25/1', fps: 25 },
  { label: '29.97 fps', rate: '30000/1001', avg: '30000/1001', fps: 30000 / 1001 },
  { label: '60 fps', rate: '60', avg: '60/1', fps: 60 },
];

describe('HLS keyframe alignment at the source frame rate', () => {
  for (const { label, rate, avg, fps } of SOURCE_RATES) {
    oracleTest(
      `${label}: every segment of every rung starts on an IDR frame at the same instant, with bounded duration and rate`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        requireEncoders('libx264', 'aac');
        const ffprobe = requireOracleTool('ffprobe');
        const { dir, rungs } = await packageHls(makeSource(rate), {
          segmentSeconds: SEGMENT_SECONDS,
          ladder: [
            { height: 360, bitrateK: 1500, audioBitrateK: 96 },
            { height: 240, bitrateK: 600, audioBitrateK: 64 },
          ],
        });
        try {
          expect(rungs.map((r) => r.name)).toEqual(['360p', '240p']);
          const starts: number[][] = [];
          for (const rung of rungs) {
            expect(rung.playlist.independentSegments).toBe(true);
            expect(rung.playlist.endList).toBe(true);
            expect(rung.playlist.segments).toHaveLength(SEGMENTS_IN_CLIP);
            const rungStarts: number[] = [];
            rung.playlist.segments.forEach((segment, n) => {
              const file = path.join(dir, segment.uri);
              const first = firstVideoPacket(ffprobe, file);
              // Every segment opens with a keyframe, and that keyframe is an IDR picture.
              expect(first.isKey, `${rung.name} segment ${n} first packet is a keyframe`).toBe(true);
              expect(firstSliceNalType(ffmpeg(), file, 'h264'), `${rung.name} segment ${n} first slice`).toBe(H264_IDR_NAL_TYPE);
              rungStarts.push(first.ptsTime);
              if (n < SEGMENTS_IN_CLIP - 1) {
                expect(Math.abs(segment.duration - SEGMENT_SECONDS), `${rung.name} EXTINF ${n}`).toBeLessThanOrEqual(
                  SEGMENT_DURATION_TOLERANCE_SEC
                );
                expect(Math.abs(containerDuration(ffprobe, file) - SEGMENT_SECONDS), `${rung.name} duration ${n}`).toBeLessThanOrEqual(
                  SEGMENT_DURATION_TOLERANCE_SEC
                );
              }
            });
            // The boundaries advance by the segment length, to within one frame of the source.
            for (let n = 1; n < rungStarts.length; n++) {
              const step = rungStarts[n] - rungStarts[n - 1];
              expect(Math.abs(step - SEGMENT_SECONDS)).toBeLessThanOrEqual(1 / fps + PTS_TOLERANCE_SEC);
            }
            starts.push(rungStarts);
            expect(videoFrameRates(ffprobe, path.join(dir, rung.playlist.segments[0].uri)).avg).toBe(avg);
          }
          // The same segment starts on the same tick in every rung.
          for (let n = 0; n < SEGMENTS_IN_CLIP; n++) {
            expect(Math.abs(starts[0][n] - starts[1][n]), `segment ${n} start across rungs`).toBeLessThanOrEqual(PTS_TOLERANCE_SEC);
          }
          // Peak segment rate against the declared BANDWIDTH.
          for (const rung of rungs) {
            let peak = 0;
            for (const segment of rung.playlist.segments) {
              peak = Math.max(peak, (fs.statSync(path.join(dir, segment.uri)).size * 8) / segment.duration);
            }
            recordMetric(`${label} ${rung.name} peak segment bitrate over BANDWIDTH`, peak / rung.bandwidth);
            expect(peak, `${rung.name} peak rate`).toBeLessThanOrEqual(rung.bandwidth * PEAK_OVER_BANDWIDTH_MAX);
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      ENCODE_TIMEOUT_MS
    );
  }

  oracleTest(
    'the packaged top rung is the source picture (SSIM) and decodes without errors',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac');
      const source = makeSource('25');
      const { dir, rungs } = await packageHls(source, {
        segmentSeconds: SEGMENT_SECONDS,
        ladder: [{ height: SOURCE_HEIGHT, bitrateK: 1500 }],
      });
      const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-source-'));
      try {
        const sourceFile = path.join(sourceDir, 'source.mp4');
        fs.writeFileSync(sourceFile, source);
        const playlist = path.join(dir, `stream_${rungs[0].name}.m3u8`);
        // Decoding the whole playlist with -xerror: any corrupt segment fails here.
        execFileSync(ffmpeg(), ['-v', 'error', '-xerror', '-i', playlist, '-f', 'null', '-']);
        const measured = measureSsimPsnr(ffmpeg(), playlist, sourceFile);
        recordMetric('hls 360p rung ssim against its source', measured.ssim);
        recordMetric('hls 360p rung psnr against its source (dB)', measured.psnr);
        expect(measured.ssim).toBeGreaterThanOrEqual(PACKAGED_MIN_SSIM);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
      }
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a 480p source with a 1080/720/480 ladder is packaged as the 480p rung only',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac');
      const { dir, master, rungs } = await packageHls(makeSource('25', 4, [], '854x480'), {
        segmentSeconds: SEGMENT_SECONDS,
        ladder: [
          { height: 1080, bitrateK: 4500 },
          { height: 720, bitrateK: 2500 },
          { height: 480, bitrateK: 1000 },
        ],
      });
      try {
        expect(master).toHaveLength(1);
        expect(master[0].resolution).toBe('854x480');
        expect(rungs.map((r) => r.name)).toEqual(['480p']);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.m3u8')).sort()).toEqual(['master.m3u8', 'stream_480p.m3u8']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a source smaller than every rung keeps one rung at the source height',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac');
      const { dir, master } = await packageHls(makeSource('25', 4, [], '320x180'), {
        segmentSeconds: SEGMENT_SECONDS,
        ladder: [{ height: 720, bitrateK: 2500 }, { height: 480, bitrateK: 1000 }],
      });
      try {
        expect(master).toHaveLength(1);
        expect(master[0].resolution).toBe('320x180');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a source with a quarter-turn display matrix is sized by its displayed height',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac');
      // Stored 640x360, displayed 360x640 (portrait): a 720 rung is taller than the picture and is dropped.
      const portrait = makeSource('25', 4, [], '640x360');
      const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-rot-'));
      try {
        const src = path.join(dir0, 'in.mp4');
        const rotated = path.join(dir0, 'rot.mp4');
        fs.writeFileSync(src, portrait);
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-display_rotation', '90', '-i', src, '-c', 'copy', rotated]);
        const ffprobe = requireOracleTool('ffprobe');
        const probed = probeVideoGeometry(rotated, resolveFfprobeBinary(ffmpeg()));
        expect({ width: probed.width, height: probed.height }).toEqual({ width: SOURCE_HEIGHT, height: SOURCE_WIDTH });
        const { dir, master } = await packageHls(fs.readFileSync(rotated), {
          segmentSeconds: SEGMENT_SECONDS,
          ladder: [{ height: 720, bitrateK: 2500 }, { height: 360, bitrateK: 800 }],
        });
        try {
          expect(master).toHaveLength(1);
          // Upright 360x640 scaled to 360 px tall is 202 wide (even), not the stored landscape shape.
          expect(master[0].resolution).toBe('202x360');
          expect(containerDuration(ffprobe, path.join(dir, 'stream_360p_000.ts'))).toBeGreaterThan(0);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(dir0, { recursive: true, force: true });
      }
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'an input without a video stream is rejected with a typed error',
    ['ffmpeg', 'ffprobe'],
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-novideo-'));
      try {
        const wav = path.join(dir, 'a.wav');
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav]);
        const err = await packageHlsDashMedia(
          fs.readFileSync(wav),
          'wav',
          { packaging: { format: 'hls' } },
          'tone'
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NoVideoStreamError);
        expect((err as Error).message).toBe('The input has no video stream, so it cannot be packaged for streaming.');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('HLS fMP4 (CMAF) and HEVC', () => {
  oracleTest(
    'fMP4 HLS has an EXT-X-MAP init section, keyframe-first segments and hvc1-tagged HEVC',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'libx265', 'aac');
      const ffprobe = requireOracleTool('ffprobe');
      const { dir, rungs } = await packageHls(makeSource('25', 10, [], '320x180'), {
        segmentSeconds: SEGMENT_SECONDS,
        segmentType: 'fmp4',
        videoCodec: 'hevc',
        ladder: [{ height: 180, bitrateK: 400 }],
      });
      try {
        const { playlist } = rungs[0];
        expect(playlist.map).toBe('init_180p.mp4');
        expect(playlist.segments.map((s) => s.uri.slice(-4))).toEqual(['.m4s', '.m4s', '.m4s']);
        const init = fs.readFileSync(path.join(dir, playlist.map!));
        // codec_tag_string of the init segment's video stream.
        const tag = execFileSync(
          ffprobe,
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,codec_tag_string', '-of', 'csv=p=0', path.join(dir, playlist.map!)],
          { encoding: 'utf8' }
        ).trim();
        expect(tag).toBe('hevc,hvc1');
        expect(init.subarray(4, 8).toString('latin1')).toBe('ftyp');
        // Each media segment, read behind the init section, starts with a keyframe: an IDR picture of HEVC.
        for (const [n, segment] of playlist.segments.entries()) {
          const joined = path.join(dir, `joined_${n}.mp4`);
          fs.writeFileSync(joined, Buffer.concat([init, fs.readFileSync(path.join(dir, segment.uri))]));
          expect(firstVideoPacket(ffprobe, joined).isKey).toBe(true);
          expect(HEVC_IDR_NAL_TYPES.has(firstSliceNalType(ffmpeg(), joined, 'hevc'))).toBe(true);
          if (n < playlist.segments.length - 1) {
            expect(Math.abs(segment.duration - SEGMENT_SECONDS)).toBeLessThanOrEqual(SEGMENT_DURATION_TOLERANCE_SEC);
          }
        }
        execFileSync(ffmpeg(), ['-v', 'error', '-xerror', '-allowed_extensions', 'ALL', '-i', path.join(dir, 'stream_180p.m3u8'), '-f', 'null', '-']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('MPEG-DASH keyframe alignment', () => {
  oracleTest(
    '25 fps: segment boundaries match across rungs, and every chunk starts on a keyframe',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac');
      const ffprobe = requireOracleTool('ffprobe');
      const result = await packageHlsDashMedia(
        makeSource('25'),
        'mp4',
        {
          packaging: {
            format: 'dash',
            segmentSeconds: SEGMENT_SECONDS,
            ladder: [{ height: 360, bitrateK: 1500 }, { height: 240, bitrateK: 600 }],
          },
        },
        'clip'
      );
      const dir = await extractZipToTemp(result.buffer);
      try {
        const sets = parseMpd(fs.readFileSync(path.join(dir, 'manifest.mpd'), 'utf8'));
        const video = sets.find((s) => s.contentType === 'video');
        expect(video?.representations).toHaveLength(2);
        const [top, low] = video!.representations;
        expect(top.segments).toHaveLength(SEGMENTS_IN_CLIP);
        // Same boundaries on both rungs, to the timescale tick.
        expect(low.segments.map((s) => s.start)).toEqual(top.segments.map((s) => s.start));
        top.segments.forEach((segment, n) => {
          if (n < top.segments.length - 1) {
            expect(Math.abs(segment.duration / top.timescale - SEGMENT_SECONDS)).toBeLessThanOrEqual(SEGMENT_DURATION_TOLERANCE_SEC);
          }
        });
        for (const rep of video!.representations) {
          const init = fs.readFileSync(path.join(dir, rep.initialization.replace('$RepresentationID$', rep.id)));
          for (let n = 0; n < rep.segments.length; n++) {
            const chunk = rep.media.replace('$RepresentationID$', rep.id).replace('$Number%05d$', String(n + 1).padStart(5, '0'));
            const joined = path.join(dir, `joined_${rep.id}_${n}.mp4`);
            fs.writeFileSync(joined, Buffer.concat([init, fs.readFileSync(path.join(dir, chunk))]));
            const first = firstVideoPacket(ffprobe, joined);
            expect(first.isKey, `representation ${rep.id} chunk ${n}`).toBe(true);
            expect(firstSliceNalType(ffmpeg(), joined, 'h264')).toBe(H264_IDR_NAL_TYPE);
            // The chunk starts at the time the manifest declares (within one timescale tick).
            expect(Math.abs(first.ptsTime - rep.segments[n].start / rep.timescale)).toBeLessThanOrEqual(2 / rep.timescale + PTS_TOLERANCE_SEC);
          }
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ENCODE_TIMEOUT_MS
  );
});

it('keeps the keyframe cadence independent of the audio presence', () => {
  const withAudio = buildHlsDashArguments('/tmp/in.mp4', '/tmp/out', { format: 'dash', ladder: [{ height: 360, bitrateK: 800 }] }, null, geometry({ height: 360 }));
  const without = buildHlsDashArguments(
    '/tmp/in.mp4',
    '/tmp/out',
    { format: 'dash', ladder: [{ height: 360, bitrateK: 800 }] },
    null,
    { ...geometry({ height: 360 }), hasAudio: false }
  );
  expect(withAudio[withAudio.indexOf('-g:v:0') + 1]).toBe('100');
  expect(without[without.indexOf('-g:v:0') + 1]).toBe('100');
  expect(without[without.indexOf('-adaptation_sets') + 1]).toBe('id=0,streams=v');
});
