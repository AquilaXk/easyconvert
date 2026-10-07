import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { amplitudeSpectrum } from './helpers/audio-spectrum';
import { pgsRectangleSup } from './helpers/pgs-sup';
import { bestSnrDb } from './helpers/media-lossy-oracle';
import {
  decodeAudioStream,
  measureSsimPsnr,
  probeFile,
  recordMetric,
  type ProbedFile,
  type ProbedStream,
} from './helpers/ffmpeg-measure';
import { assertDecodedMedia, LOSSY_AUDIO_MIN_SNR_DB, VIDEO_MIN_SSIM } from './oracles/product/media-oracle';
import { convertMedia } from '../src/lib/conversions/media';
import { buildFfmpegArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { MAX_MAPPED_STREAMS, type InputStream } from '../src/lib/conversions/media-ffprobe';
import {
  BITMAP_SUBTITLE_CODECS,
  SUBTITLE_CODEC_BY_CONTAINER,
  planStreamMapping,
} from '../src/lib/conversions/media-stream-plan';
import { InvalidMediaOptionError, TooManyMediaStreamsError } from '../src/lib/types';

/**
 * A transcode keeps every audio and subtitle track with its language and disposition, the chapters, and
 * (for mkv) the attachments; it rotates once, keeps the source's frame timestamps unless a rate is
 * requested, and keeps audio in step with the picture. Oracles: ffprobe streams, chapters and side data,
 * ffmpeg decodes of every track, and clips authored here from lavfi sources.
 */

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 25;
const CLIP_SECONDS = 3;
const CLIP_FRAMES = FPS * CLIP_SECONDS;
const SAMPLE_RATE = 44100;
const FIRST_TONE_HZ = 440;
const SECOND_TONE_HZ = 880;
/** Largest drift of a decoded AAC track from its source length: priming plus padding, two 1024-sample frames. */
const AAC_PADDING_SAMPLES = 2048;
const CHAPTER_TOLERANCE_SEC = 0.001;
const TONE_BIN_TOLERANCE_HZ = 4;
const FFT_SIZE = 16384;
const SPECTRUM_OFFSET_SAMPLES = 8192;
const ENCODE_TIMEOUT_MS = 120_000;

const CHAPTERS = [
  { startMs: 0, endMs: 1000, title: 'Intro' },
  { startMs: 1000, endMs: 2000, title: 'Middle' },
  { startMs: 2000, endMs: 3000, title: 'Outro' },
];
const ENGLISH_CUE = 'Hello English';
const KOREAN_CUE = '안녕하세요 한국어';

function ffmpeg(): string {
  return requireOracleTool('ffmpeg');
}
function ffprobe(): string {
  return requireOracleTool('ffprobe');
}

function withWorkDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-map-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withWorkDirAsync<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-map-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(args: string[]): void {
  execFileSync(ffmpeg(), ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function probeBytes(bytes: Buffer, extension: string): ProbedFile {
  return withWorkDir((dir) => {
    const file = path.join(dir, `in.${extension}`);
    fs.writeFileSync(file, bytes);
    return probeFile(ffprobe(), file);
  });
}

function streamsOf(probed: ProbedFile, type: string): ProbedStream[] {
  return probed.streams.filter((s) => s.codec_type === type);
}

/** The cue text the reference ffmpeg reads from subtitle track `index` of `bytes`, as SubRip. */
function subtitleText(bytes: Buffer, extension: string, index: number): string {
  return withWorkDir((dir) => {
    const file = path.join(dir, `in.${extension}`);
    fs.writeFileSync(file, bytes);
    return execFileSync(ffmpeg(), ['-v', 'error', '-i', file, '-map', `0:s:${index}`, '-f', 'srt', '-'], { encoding: 'utf8' });
  });
}

function dominantFrequencyHz(pcm: Buffer, rate: number): number {
  const samples = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) samples[i] = pcm.readInt16LE((SPECTRUM_OFFSET_SAMPLES + i) * 2);
  const spectrum = amplitudeSpectrum(samples, 0, FFT_SIZE);
  let peak = 1;
  for (let k = 1; k < spectrum.length; k++) if (spectrum[k] > spectrum[peak]) peak = k;
  return (peak * rate) / FFT_SIZE;
}

interface MultiTrackFixture {
  mkv: Buffer;
  attachmentName: string;
}

/**
 * 3 s of 320x180 25 fps H.264 with two PCM tracks (English 440 Hz default, Korean 880 Hz), two SubRip tracks,
 * three chapters and one attachment: the shape of a media-library file. The audio is PCM so that the source has
 * no encoder-delay start offset, which ffmpeg would otherwise add to every chapter time it copies.
 */
function multiTrackMkv(dir: string): MultiTrackFixture {
  requireEncoders('libx264');
  const attachmentName = 'notes.bin';
  fs.writeFileSync(path.join(dir, attachmentName), Buffer.from('attachment payload that must survive an mkv to mkv conversion'));
  fs.writeFileSync(path.join(dir, 'eng.srt'), `1\n00:00:00,500 --> 00:00:02,500\n${ENGLISH_CUE}\n\n`);
  fs.writeFileSync(path.join(dir, 'kor.srt'), `1\n00:00:00,500 --> 00:00:02,500\n${KOREAN_CUE}\n\n`);
  const meta = [
    ';FFMETADATA1',
    'title=Multi track fixture',
    ...CHAPTERS.flatMap((c) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${c.startMs}`, `END=${c.endMs}`, `title=${c.title}`]),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'meta.txt'), meta);
  const out = path.join(dir, 'multi.mkv');
  run([
    '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${CLIP_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=${FIRST_TONE_HZ}:sample_rate=${SAMPLE_RATE}:duration=${CLIP_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=${SECOND_TONE_HZ}:sample_rate=${SAMPLE_RATE}:duration=${CLIP_SECONDS}`,
    '-i', path.join(dir, 'eng.srt'), '-i', path.join(dir, 'kor.srt'), '-i', path.join(dir, 'meta.txt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
    '-map_metadata', '5', '-map_chapters', '5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-c:a', 'pcm_s16le', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English',
    '-metadata:s:a:1', 'language=kor', '-metadata:s:a:1', 'title=Korean',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=kor',
    '-disposition:a:0', 'default', '-disposition:a:1', '0',
    '-attach', path.join(dir, attachmentName), '-metadata:s:t:0', 'mimetype=application/octet-stream',
    out,
  ]);
  return { mkv: fs.readFileSync(out), attachmentName };
}

function languages(streams: ProbedStream[]): Array<string | undefined> {
  return streams.map((s) => s.tags?.language);
}

describe('stream mapping plan (pure)', () => {
  const stream = (index: number, type: InputStream['type'], codecName: string, extra: Partial<InputStream> = {}): InputStream => ({
    index,
    type,
    codecName,
    attachedPicture: false,
    rotation: 0,
    ...extra,
  });
  const library: InputStream[] = [
    stream(0, 'video', 'h264'),
    stream(1, 'audio', 'aac'),
    stream(2, 'audio', 'aac'),
    stream(3, 'subtitle', 'subrip'),
    stream(4, 'subtitle', 'ass'),
    stream(5, 'attachment', 'ttf'),
    stream(6, 'data', 'bin_data'),
  ];

  it('maps the video, every audio track and every text subtitle, in that order', () => {
    const plan = planStreamMapping({ streams: library, container: 'mp4', burnSubtitles: false });
    expect(plan.maps).toEqual(['0:0', '0:1', '0:2', '0:3', '0:4']);
    expect(plan.subtitleCodec).toBe('mov_text');
    expect(plan.subtitleCount).toBe(2);
  });

  it('keeps attachments for mkv only and never maps data streams', () => {
    expect(planStreamMapping({ streams: library, container: 'mkv', burnSubtitles: false }).maps).toEqual([
      '0:0', '0:1', '0:2', '0:3', '0:4', '0:5',
    ]);
    expect(planStreamMapping({ streams: library, container: 'webm', burnSubtitles: false }).subtitleCodec).toBe('webvtt');
    expect(planStreamMapping({ streams: library, container: 'mkv', burnSubtitles: false }).subtitleCodec).toBe('copy');
  });

  it('carries no subtitle in avi and none when they are burned into the picture', () => {
    expect(planStreamMapping({ streams: library, container: 'avi', burnSubtitles: false }).maps).toEqual(['0:0', '0:1', '0:2']);
    expect(planStreamMapping({ streams: library, container: 'mp4', burnSubtitles: true }).maps).toEqual(['0:0', '0:1', '0:2']);
  });

  it('selects one audio track by index and rejects an index the input lacks', () => {
    expect(planStreamMapping({ streams: library, container: 'mp4', audioTrack: 1, burnSubtitles: false }).maps).toContain('0:2');
    expect(planStreamMapping({ streams: library, container: 'mp4', audioTrack: 1, burnSubtitles: false }).maps).not.toContain('0:1');
    expect(() => planStreamMapping({ streams: library, container: 'mp4', audioTrack: 2, burnSubtitles: false })).toThrow(/Audio track 2/);
  });

  it('rejects a bitmap subtitle for a text-only container, naming the stream, and copies it into mkv', () => {
    const pgs = [stream(0, 'video', 'h264'), stream(1, 'subtitle', 'hdmv_pgs_subtitle')];
    for (const container of ['mp4', 'mov', 'webm'] as const) {
      expect(() => planStreamMapping({ streams: pgs, container, burnSubtitles: false })).toThrow(InvalidMediaOptionError);
    }
    expect(() => planStreamMapping({ streams: pgs, container: 'mp4', burnSubtitles: false })).toThrow(/stream #1 \(hdmv_pgs_subtitle\).*"burn"/);
    expect(planStreamMapping({ streams: pgs, container: 'mkv', burnSubtitles: false }).maps).toEqual(['0:0', '0:1']);
    expect(planStreamMapping({ streams: pgs, container: 'mp4', burnSubtitles: true }).maps).toEqual(['0:0']);
  });

  it('skips cover art when choosing the video track', () => {
    const withCover = [stream(0, 'video', 'mjpeg', { attachedPicture: true }), stream(1, 'video', 'h264'), stream(2, 'audio', 'aac')];
    const plan = planStreamMapping({ streams: withCover, container: 'mp4', burnSubtitles: false });
    expect(plan.maps).toEqual(['0:1', '0:2']);
    expect(plan.videoIndex).toBe(1);
  });

  it('names the bitmap codecs and the per-container subtitle codecs as constants', () => {
    expect([...BITMAP_SUBTITLE_CODECS].sort()).toEqual(['dvb_subtitle', 'dvd_subtitle', 'hdmv_pgs_subtitle']);
    expect(SUBTITLE_CODEC_BY_CONTAINER).toEqual({
      mp4: { text: 'mov_text', bitmap: null },
      mov: { text: 'mov_text', bitmap: null },
      webm: { text: 'webvtt', bitmap: null },
      mkv: { text: 'copy', bitmap: 'copy' },
    });
  });
});

describe('frame rate and audio sync arguments', () => {
  const base = (video: object, extra: object = {}) =>
    buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', { disableHwaccel: true, ...extra, video: { codec: 'h264', ...video } } as never);

  it('keeps variable frame rate with -fps_mode passthrough when no rate is requested', () => {
    const args = base({});
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('passthrough');
    expect(args).not.toContain('-r');
  });

  it('uses only the fps filter when a rate is requested, from video.fps or the legacy videoFps', () => {
    for (const args of [base({ fps: 24 }), base({}, { videoFps: 24 })]) {
      expect(args.indexOf('-r')).toBe(-1);
      expect(args.indexOf('-fps_mode')).toBe(-1);
      expect(args[args.indexOf('-vf') + 1]).toContain('fps=24');
    }
  });

  it('rejects a frame rate outside 0..240 instead of ignoring it', () => {
    expect(() => base({ fps: 0 })).toThrow(InvalidMediaOptionError);
    expect(() => base({ fps: 1000 })).toThrow(InvalidMediaOptionError);
  });

  it('resamples re-encoded audio to start at zero, before any other audio filter', () => {
    const args = base({}, { audio: { codec: 'aac', volume: 50 } });
    expect(args[args.indexOf('-filter:a') + 1]).toBe('aresample=async=1:first_pts=0,volume=0.5');
  });
});

describe('every track of a multi-track source survives a container change', () => {
  oracleTest(
    'mkv with 2 audio tracks, 2 subtitle tracks, chapters and an attachment becomes an mp4 with 1 video, 2 audio and 2 mov_text tracks',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const { mkv } = multiTrackMkv(dir);
        const result = await convertMedia(mkv, 'mkv', 'mp4', {}, 'multi.mkv');
        const probed = probeBytes(result.buffer, 'mp4');
        const audio = streamsOf(probed, 'audio');
        const subtitles = streamsOf(probed, 'subtitle');

        expect(streamsOf(probed, 'video')).toHaveLength(1);
        expect(audio).toHaveLength(2);
        expect(subtitles.map((s) => s.codec_name)).toEqual(['mov_text', 'mov_text']);
        expect(languages(audio)).toEqual(['eng', 'kor']);
        expect(languages(subtitles)).toEqual(['eng', 'kor']);
        // An mp4 track has no title field; its name is the handler name.
        expect(audio.map((s) => s.tags?.handler_name)).toEqual(['English', 'Korean']);
        expect(audio.map((s) => s.disposition?.default)).toEqual([1, 0]);

        // Attachments belong to mkv; an mp4 carries none and the conversion does not fail on them.
        expect(streamsOf(probed, 'attachment')).toHaveLength(0);

        // Chapters: same count, same start times.
        expect(probed.chapters).toHaveLength(CHAPTERS.length);
        probed.chapters.forEach((chapter, i) => {
          expect(Math.abs(Number(chapter.start_time) - CHAPTERS[i].startMs / 1000)).toBeLessThanOrEqual(CHAPTER_TOLERANCE_SEC);
          expect(chapter.tags?.title).toBe(CHAPTERS[i].title);
        });

        // Subtitle text survives, each in its own track.
        expect(subtitleText(result.buffer, 'mp4', 0)).toContain(ENGLISH_CUE);
        expect(subtitleText(result.buffer, 'mp4', 1)).toContain(KOREAN_CUE);

        // Decoded: the picture is the source, and each audio track is its own tone (not swapped, not silent).
        const source = path.join(dir, 'multi.mkv');
        const decoded = assertDecodedMedia(result.buffer, 'mp4', 'video', {
          streams: { video: 1, audio: 2, subtitle: 2 },
          video: { frameCount: CLIP_FRAMES, reference: { bytes: mkv, extension: 'mkv' }, minSsim: VIDEO_MIN_SSIM },
        });
        expect(decoded.video?.frameCount).toBe(CLIP_FRAMES);
        for (const [index, hz] of [FIRST_TONE_HZ, SECOND_TONE_HZ].entries()) {
          const track = assertDecodedMedia(
            result.buffer,
            'mp4',
            'audio',
            { audio: { sampleRate: SAMPLE_RATE, channels: 1, samplesPerChannel: SAMPLE_RATE * CLIP_SECONDS, toleranceSamples: AAC_PADDING_SAMPLES } },
            { audioStreamIndex: index, sampleRate: SAMPLE_RATE, channels: 1 }
          );
          expect(Math.abs(dominantFrequencyHz(track.audio!.pcm, SAMPLE_RATE) - hz), `track ${index}`).toBeLessThanOrEqual(TONE_BIN_TOLERANCE_HZ);
          // Against the same track of the source, decoded by the reference decoder.
          const reference = decodeAudioStream(ffmpeg(), source, SAMPLE_RATE, 1, index);
          const refSamples = new Int16Array(reference.pcm.length / 2).map((_, i) => reference.pcm.readInt16LE(i * 2));
          const outSamples = new Int16Array(track.audio!.pcm.length / 2).map((_, i) => track.audio!.pcm.readInt16LE(i * 2));
          assertSnr(refSamples, outSamples, LOSSY_AUDIO_MIN_SNR_DB.aac, `audio track ${index}`);
        }
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'mkv to mkv keeps the subtitle tracks, the attachment and the chapters',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const { mkv, attachmentName } = multiTrackMkv(dir);
        const result = await convertMedia(mkv, 'mkv', 'mkv', {}, 'multi.mkv');
        const probed = probeBytes(result.buffer, 'mkv');
        expect(streamsOf(probed, 'audio')).toHaveLength(2);
        expect(streamsOf(probed, 'subtitle').map((s) => s.codec_name)).toEqual(['subrip', 'subrip']);
        const attachments = streamsOf(probed, 'attachment');
        expect(attachments).toHaveLength(1);
        expect(attachments[0].tags?.filename).toBe(attachmentName);
        expect(probed.chapters).toHaveLength(CHAPTERS.length);
        assertDecodedMedia(result.buffer, 'mkv', 'video', { streams: { video: 1, audio: 2, subtitle: 2, data: 1 }, video: { frameCount: CLIP_FRAMES } });
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'webm carries both tracks as Opus and the subtitles as WebVTT',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libvpx-vp9', 'libopus');
      await withWorkDirAsync(async (dir) => {
        const { mkv } = multiTrackMkv(dir);
        const result = await convertMedia(mkv, 'mkv', 'webm', {}, 'multi.mkv');
        const probed = probeBytes(result.buffer, 'webm');
        expect(streamsOf(probed, 'audio').map((s) => s.codec_name)).toEqual(['opus', 'opus']);
        expect(languages(streamsOf(probed, 'audio'))).toEqual(['eng', 'kor']);
        expect(streamsOf(probed, 'subtitle').map((s) => s.codec_name)).toEqual(['webvtt', 'webvtt']);
        expect(subtitleText(result.buffer, 'webm', 1)).toContain(KOREAN_CUE);
        assertDecodedMedia(result.buffer, 'webm', 'video', {
          streams: { video: 1, audio: 2, subtitle: 2 },
          video: { frameCount: CLIP_FRAMES, reference: { bytes: mkv, extension: 'mkv' }, minSsim: VIDEO_MIN_SSIM },
        });
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'audio.track selects exactly that track',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const { mkv } = multiTrackMkv(dir);
        const result = await convertMedia(mkv, 'mkv', 'mp4', { audio: { track: 1 } }, 'multi.mkv');
        const probed = probeBytes(result.buffer, 'mp4');
        expect(languages(streamsOf(probed, 'audio'))).toEqual(['kor']);
        const decoded = assertDecodedMedia(result.buffer, 'mp4', 'audio', {
          streams: { audio: 1 },
          audio: { sampleRate: SAMPLE_RATE, channels: 1, samplesPerChannel: SAMPLE_RATE * CLIP_SECONDS, toleranceSamples: AAC_PADDING_SAMPLES },
        }, { sampleRate: SAMPLE_RATE, channels: 1 });
        expect(Math.abs(dominantFrequencyHz(decoded.audio!.pcm, SAMPLE_RATE) - SECOND_TONE_HZ)).toBeLessThanOrEqual(TONE_BIN_TOLERANCE_HZ);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'avi cannot hold subtitles: both audio tracks are kept and the subtitles are not written',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const { mkv } = multiTrackMkv(dir);
        const result = await convertMedia(mkv, 'mkv', 'avi', {}, 'multi.mkv');
        const probed = probeBytes(result.buffer, 'avi');
        expect(streamsOf(probed, 'audio')).toHaveLength(2);
        expect(streamsOf(probed, 'subtitle')).toHaveLength(0);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'an input with more streams than the mapping limit is rejected with a typed error',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const tracks = MAX_MAPPED_STREAMS + 1;
        const inputs = Array.from({ length: tracks }, () => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1']).flat();
        const maps = Array.from({ length: tracks }, (_, i) => ['-map', String(i)]).flat();
        const out = path.join(dir, 'many.mkv');
        run([...inputs, ...maps, '-c:a', 'pcm_s16le', out]);
        const error = await convertMedia(fs.readFileSync(out), 'mkv', 'mp4', {}, 'many.mkv').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TooManyMediaStreamsError);
        expect((error as Error).message).toContain(`at most ${MAX_MAPPED_STREAMS}`);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('bitmap and burned-in subtitles', () => {
  const RECT = { width: WIDTH, height: HEIGHT, x: 20, y: 20, w: 100, h: 40, startMs: 500, endMs: 2500 };
  /** The rectangle is opaque white on testsrc2's coloured bars: it moves the mean absolute difference far past this. */
  const MIN_REGION_MEAN_ABS_DIFF = 40;
  /** Outside the rectangle the burned frame is the source frame, re-encoded losslessly: PSNR is far above this. */
  const MIN_OUTSIDE_PSNR_DB = 40;
  /** One second in: inside the 0.5 s to 2.5 s window the subtitle is shown. */
  const SAMPLE_FRAME = FPS;

  function pgsMkv(dir: string): Buffer {
    requireEncoders('libx264');
    fs.writeFileSync(path.join(dir, 'rect.sup'), pgsRectangleSup(RECT));
    run(['-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${CLIP_SECONDS}`, '-i', path.join(dir, 'rect.sup'),
      '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-qp', '0', '-c:s', 'copy', path.join(dir, 'pgs.mkv')]);
    return fs.readFileSync(path.join(dir, 'pgs.mkv'));
  }

  /**
   * Luma plane (8-bit, one byte per pixel) of the frame with index `SAMPLE_FRAME`: selected by index, so no seek
   * can land on a neighbour, and read from the decoded yuv420p planes, so no colour-matrix guess enters the comparison.
   */
  function frameAt(file: string): Buffer {
    return execFileSync(
      ffmpeg(),
      ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `select=eq(n\\,${SAMPLE_FRAME})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
      { maxBuffer: 16 * 1024 * 1024 }
    ).subarray(0, WIDTH * HEIGHT);
  }

  function regionStats(a: Buffer, b: Buffer, rect: { x: number; y: number; w: number; h: number }): { meanAbsDiff: number; outsidePsnr: number } {
    let inside = 0;
    let insideCount = 0;
    let outsideSq = 0;
    let outsideCount = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const inRect = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        const d = a[y * WIDTH + x] - b[y * WIDTH + x];
        if (inRect) {
          inside += Math.abs(d);
          insideCount++;
        } else {
          outsideSq += d * d;
          outsideCount++;
        }
      }
    }
    const mse = outsideSq / outsideCount;
    return { meanAbsDiff: inside / insideCount, outsidePsnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse) };
  }

  oracleTest(
    'a PGS subtitle into mp4 without burn is a typed option error that names the stream',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const source = pgsMkv(dir);
        for (const target of ['mp4', 'mov', 'webm'] as const) {
          const error = await convertMedia(source, 'mkv', target, {}, 'pgs.mkv').catch((e: unknown) => e);
          expect(error, target).toBeInstanceOf(InvalidMediaOptionError);
          expect((error as Error).message).toMatch(/Subtitle stream #1 \(hdmv_pgs_subtitle\) is a bitmap subtitle/);
        }
        // mkv carries it unchanged.
        const kept = await convertMedia(source, 'mkv', 'mkv', {}, 'pgs.mkv');
        expect(streamsOf(probeBytes(kept.buffer, 'mkv'), 'subtitle').map((s) => s.codec_name)).toEqual(['hdmv_pgs_subtitle']);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'burning a PGS subtitle changes only the subtitle region of the picture',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const source = pgsMkv(dir);
        const result = await convertMedia(
          source,
          'mkv',
          'mp4',
          { subtitles: { mode: 'burn' }, video: { codec: 'h264', rateControl: { mode: 'crf', crf: 0 } } },
          'pgs.mkv'
        );
        const probed = probeBytes(result.buffer, 'mp4');
        expect(streamsOf(probed, 'subtitle')).toHaveLength(0);
        expect(streamsOf(probed, 'video')).toHaveLength(1);
        const outFile = path.join(dir, 'burned.mp4');
        fs.writeFileSync(outFile, result.buffer);
        const stats = regionStats(frameAt(outFile), frameAt(path.join(dir, 'pgs.mkv')), RECT);
        recordMetric('burned PGS: mean absolute difference inside the subtitle region', stats.meanAbsDiff);
        recordMetric('burned PGS: PSNR outside the subtitle region (dB)', stats.outsidePsnr);
        expect(stats.meanAbsDiff).toBeGreaterThan(MIN_REGION_MEAN_ABS_DIFF);
        expect(stats.outsidePsnr).toBeGreaterThanOrEqual(MIN_OUTSIDE_PSNR_DB);
        assertDecodedMedia(result.buffer, 'mp4', 'video', { streams: { video: 1, subtitle: 0 }, video: { frameCount: CLIP_FRAMES } });
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'burning an embedded text subtitle draws text into the lower picture and leaves the upper picture alone',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        requireEncoders('libx264');
        fs.writeFileSync(path.join(dir, 'cue.srt'), `1\n00:00:00,500 --> 00:00:02,500\nBURNED CUE TEXT\n\n`);
        run(['-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${CLIP_SECONDS}`, '-i', path.join(dir, 'cue.srt'),
          '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-qp', '0', '-c:s', 'srt', path.join(dir, 'text.mkv')]);
        const result = await convertMedia(
          fs.readFileSync(path.join(dir, 'text.mkv')),
          'mkv',
          'mp4',
          { subtitles: { mode: 'burn' }, video: { codec: 'h264', rateControl: { mode: 'crf', crf: 0 } } },
          'text.mkv'
        );
        expect(streamsOf(probeBytes(result.buffer, 'mp4'), 'subtitle')).toHaveLength(0);
        const outFile = path.join(dir, 'burned.mp4');
        fs.writeFileSync(outFile, result.buffer);
        // Subtitles sit at the bottom: the lower fifth changes, the upper half is the source.
        const lowerBand = { x: 0, y: Math.floor(HEIGHT * 0.8), w: WIDTH, h: HEIGHT - Math.floor(HEIGHT * 0.8) };
        const stats = regionStats(frameAt(outFile), frameAt(path.join(dir, 'text.mkv')), lowerBand);
        const upperHalf = regionStats(frameAt(outFile), frameAt(path.join(dir, 'text.mkv')), { x: 0, y: 0, w: WIDTH, h: Math.floor(HEIGHT / 2) });
        expect(stats.meanAbsDiff).toBeGreaterThan(1);
        // Everything outside the lower band is unchanged, so the whole upper half is identical to the source.
        expect(upperHalf.meanAbsDiff).toBe(0);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('rotation is applied exactly once', () => {
  const MIN_ROTATION_SSIM = 0.95;

  /** 320x180 testsrc2 (asymmetric on purpose) stored upright, plus the same stream flagged with a 90 degree display matrix. */
  function rotatedPair(dir: string): { stored: string; flagged: string } {
    requireEncoders('libx264');
    const stored = path.join(dir, 'stored.mp4');
    const flagged = path.join(dir, 'flagged.mp4');
    run(['-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', stored]);
    run(['-display_rotation', '90', '-i', stored, '-c', 'copy', flagged]);
    return { stored, flagged };
  }

  /** A lossless reference: `filter` applied by ffmpeg to the stored frames. */
  function reference(dir: string, stored: string, name: string, filter: string): string {
    const out = path.join(dir, `${name}.mp4`);
    run(['-i', stored, '-vf', filter, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', out]);
    return out;
  }

  function outputVideo(result: Buffer, dir: string, name: string): { file: string; stream: ProbedStream } {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, result);
    return { file, stream: streamsOf(probeFile(ffprobe(), file), 'video')[0] };
  }

  function hasDisplayMatrix(stream: ProbedStream): boolean {
    return (stream.side_data_list ?? []).some((entry) => entry.side_data_type === 'Display Matrix' && Number(entry.rotation) !== 0);
  }

  oracleTest(
    'a display matrix is applied once: the picture is upright and no rotation side data is left to apply again',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const { stored, flagged } = rotatedPair(dir);
        // The flagged clip shows the stored picture turned 90 degrees counter-clockwise.
        const upright = reference(dir, stored, 'upright', 'transpose=2');
        const result = await convertMedia(fs.readFileSync(flagged), 'mp4', 'mp4', {}, 'flagged.mp4');
        const out = outputVideo(result.buffer, dir, 'out');
        expect({ width: out.stream.width, height: out.stream.height }).toEqual({ width: HEIGHT, height: WIDTH });
        expect(hasDisplayMatrix(out.stream)).toBe(false);
        const measured = measureSsimPsnr(ffmpeg(), out.file, upright);
        recordMetric('rotation: display matrix applied once, ssim against the upright reference', measured.ssim);
        expect(measured.ssim).toBeGreaterThanOrEqual(MIN_ROTATION_SSIM);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'rotate on top of a display matrix turns the upright picture by exactly the requested angle',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const { stored, flagged } = rotatedPair(dir);
        const bytes = fs.readFileSync(flagged);
        // Upright is the stored picture turned 90 degrees counter-clockwise; rotate is clockwise from there.
        const cases: Array<{ rotate: 90 | 180 | 270; filter: string; width: number; height: number }> = [
          { rotate: 90, filter: 'null', width: WIDTH, height: HEIGHT },
          { rotate: 180, filter: 'transpose=2,transpose=2,transpose=2', width: HEIGHT, height: WIDTH },
          { rotate: 270, filter: 'hflip,vflip', width: WIDTH, height: HEIGHT },
        ];
        for (const c of cases) {
          const expected = reference(dir, stored, `expected_${c.rotate}`, c.filter);
          const result = await convertMedia(bytes, 'mp4', 'mp4', { video: { codec: 'h264', rotate: c.rotate } }, 'flagged.mp4');
          const out = outputVideo(result.buffer, dir, `out_${c.rotate}`);
          expect({ width: out.stream.width, height: out.stream.height }, `rotate ${c.rotate}`).toEqual({ width: c.width, height: c.height });
          expect(hasDisplayMatrix(out.stream), `rotate ${c.rotate} side data`).toBe(false);
          const measured = measureSsimPsnr(ffmpeg(), out.file, expected);
          recordMetric(`rotation: rotate ${c.rotate} over a display matrix, ssim against its reference`, measured.ssim);
          expect(measured.ssim, `rotate ${c.rotate}`).toBeGreaterThanOrEqual(MIN_ROTATION_SSIM);
        }
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('frame timing and audio sync', () => {
  /** 4 s of 30 fps testsrc2 thinned to an irregular cadence, so the frame timestamps are not on a fixed grid. */
  function variableRateSource(dir: string): string {
    requireEncoders('libx264');
    const out = path.join(dir, 'vfr.mp4');
    run([
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=4',
      '-vf', "select='not(mod(n,3))+not(mod(n,7))'", '-fps_mode', 'passthrough',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
    ]);
    return out;
  }

  function frameTimes(file: string): number[] {
    const out = execFileSync(ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l !== '').map((l) => Number(l.split(',')[0]));
  }

  /** One frame at the cadence's finest step (1/30 s): the timestamps must match to a fraction of that. */
  const FRAME_TIME_TOLERANCE_SEC = 0.001;

  oracleTest(
    'a variable frame rate source keeps its frame count and frame timestamps',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const source = variableRateSource(dir);
        const sourceTimes = frameTimes(source);
        // The fixture is genuinely variable: more than one distinct gap between frames.
        const gaps = new Set(sourceTimes.slice(1).map((t, i) => (t - sourceTimes[i]).toFixed(4)));
        expect(gaps.size).toBeGreaterThan(1);
        for (const target of ['mp4', 'mkv'] as const) {
          const result = await convertMedia(fs.readFileSync(source), 'mp4', target, {}, 'vfr.mp4');
          const out = path.join(dir, `out.${target}`);
          fs.writeFileSync(out, result.buffer);
          const times = frameTimes(out);
          expect(times, target).toHaveLength(sourceTimes.length);
          times.forEach((t, i) => expect(Math.abs(t - sourceTimes[i]), `${target} frame ${i}`).toBeLessThanOrEqual(FRAME_TIME_TOLERANCE_SEC));
        }
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a requested frame rate produces a constant rate with the matching frame count',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        const source = variableRateSource(dir);
        const cases = [
          { rate: 10, options: { video: { codec: 'h264', fps: 10 } } },
          { rate: 24, options: { videoFps: 24 } },
        ];
        for (const { rate, options } of cases) {
          const result = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', options as never, 'vfr.mp4');
          const out = path.join(dir, `rate_${rate}.mp4`);
          fs.writeFileSync(out, result.buffer);
          const times = frameTimes(out);
          // Constant rate: every gap is one frame period.
          times.slice(1).forEach((t, i) => expect(Math.abs(t - times[i] - 1 / rate), `${rate} fps frame ${i}`).toBeLessThanOrEqual(FRAME_TIME_TOLERANCE_SEC));
          const stream = streamsOf(probeFile(ffprobe(), out), 'video')[0];
          expect(stream.avg_frame_rate).toBe(`${rate}/1`);
        }
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'audio that starts late in the source starts with the picture in the output, its onset still half a second in',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withWorkDirAsync(async (dir) => {
        requireEncoders('libx264', 'aac');
        const LATE_START_SEC = 0.5;
        const source = path.join(dir, 'late.mkv');
        run([
          '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=${FPS}:duration=3`,
          '-itsoffset', String(LATE_START_SEC), '-f', 'lavfi', '-i', `sine=frequency=${FIRST_TONE_HZ}:sample_rate=${SAMPLE_RATE}:duration=2.5`,
          '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source,
        ]);
        const sourceProbe = probeFile(ffprobe(), source);
        expect(Number(streamsOf(sourceProbe, 'audio')[0].start_time)).toBeGreaterThanOrEqual(LATE_START_SEC - 0.05);

        const result = await convertMedia(fs.readFileSync(source), 'mkv', 'mp4', {}, 'late.mkv');
        const out = path.join(dir, 'out.mp4');
        fs.writeFileSync(out, result.buffer);
        const probed = probeFile(ffprobe(), out);
        const videoStart = Number(streamsOf(probed, 'video')[0].start_time);
        const audioStart = Number(streamsOf(probed, 'audio')[0].start_time);
        // Start difference within one frame duration.
        expect(Math.abs(audioStart - videoStart)).toBeLessThanOrEqual(1 / FPS);

        // The content is still in step: silence until about 0.5 s, then the tone.
        const decoded = decodeAudioStream(ffmpeg(), out, SAMPLE_RATE, 1);
        const rms = (from: number, to: number): number => {
          let sum = 0;
          for (let i = Math.floor(from * SAMPLE_RATE); i < Math.floor(to * SAMPLE_RATE); i++) sum += decoded.pcm.readInt16LE(i * 2) ** 2;
          return Math.sqrt(sum / ((to - from) * SAMPLE_RATE));
        };
        const SILENT_RMS_MAX = 50;
        const TONE_RMS_MIN = 1000;
        expect(rms(0.05, LATE_START_SEC - 0.1)).toBeLessThan(SILENT_RMS_MAX);
        expect(rms(LATE_START_SEC + 0.2, 2.5)).toBeGreaterThan(TONE_RMS_MIN);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

function assertSnr(reference: Int16Array, actual: Int16Array, minDb: number, label: string): void {
  const snr = bestSnrDb(reference, actual, 1);
  recordMetric(`${label}: snr against the source track (dB)`, snr);
  expect(snr, label).toBeGreaterThanOrEqual(minDb);
}
