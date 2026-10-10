import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFfmpegArguments, resetHardwareAccelerationCache } from '../src/lib/conversions/media-ffmpeg-args';
import { probeMediaDuration } from '../src/lib/conversions/media';
import { InvalidMediaOptionError } from '../src/lib/types';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { measureSsimPsnr, probeFile } from './helpers/ffmpeg-measure';
import { oracleTest } from './helpers/oracle-test';

/**
 * What a video conversion costs besides the encoder. A plain MP4 describes its streams in its header, so planning the
 * stream mapping needs no prober process; any other input is probed once for everything the conversion asks, not once
 * per question. The encoded picture must still be the one the reference encoder writes at the same settings. The
 * process counts come from recording wrappers around the real binaries, the picture facts from ffprobe, and the
 * quality from ffmpeg's own SSIM and PSNR filters against the source.
 */

const TEST_TIMEOUT_MS = 240_000;
const SIZE = '160x120';
const SECONDS = 1;
const CRF = 24;
const TONE_HZ = 440;
/** Sizes of two encodes at one setting differ by container bookkeeping only. */
const SIZE_TOLERANCE = 0.03;
const PSNR_TOLERANCE_DB = 0.1;
const DURATION_TOLERANCE_S = 0.1;

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-video-overhead-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function tool(name: 'ffmpeg' | 'ffprobe'): string {
  const found = getOracleToolPath(name);
  if (found === null) throw new Error(`${name} is not installed`);
  return found;
}

const VIDEO_IN = ['-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=24:duration=${SECONDS}`];
const AUDIO_IN = ['-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=44100:duration=${SECONDS}`];

function make(name: string, args: string[]): string {
  const out = path.join(workDir, name);
  execFileSync(tool('ffmpeg'), ['-v', 'error', '-y', ...args, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

/** A plain MP4 of an H.264 picture and an AAC track, as an encoder or a phone writes it. */
function plainMp4(): string {
  requireEncoders('libx264', 'aac');
  return make('plain.mp4', [...VIDEO_IN, ...AUDIO_IN, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
}

/** Bytes of the video packets of a file, from ffprobe. */
function videoBytes(file: string): number {
  const sizes = execFileSync(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', file], {
    encoding: 'utf-8',
  });
  return sizes
    .trim()
    .split('\n')
    .reduce((sum, line) => sum + Number(line), 0);
}

interface Call {
  tool: string;
  args: string[];
}

/**
 * A directory holding wrappers named `ffmpeg` and `ffprobe` that append every invocation to a log and then run the
 * real binary. Used as the sibling pair the engine resolves, it records exactly the processes a conversion starts.
 */
function recordingBinaries(label: string): { ffmpeg: string; calls: () => Call[] } {
  const dir = path.join(workDir, `wrappers-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    const script = `#!/bin/sh\nprintf '%s' "${name}" >> '${log}'\nfor a in "$@"; do printf '\\t%s' "$a" >> '${log}'; done\nprintf '\\n' >> '${log}'\nexec '${tool(name)}' "$@"\n`;
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  }
  return {
    ffmpeg: path.join(dir, 'ffmpeg'),
    calls: () =>
      fs
        .readFileSync(log, 'utf-8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const [name, ...args] = line.split('\t');
          return { tool: name, args };
        }),
  };
}

describe('conversions of a plain MP4', () => {
  const previousFfmpeg = process.env.FFMPEG_PATH;
  afterAll(() => {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previousFfmpeg;
  });

  async function convert(input: string, target: string, recorder: ReturnType<typeof recordingBinaries>, options: Record<string, unknown> = {}) {
    process.env.FFMPEG_PATH = recorder.ffmpeg;
    const result = await convertWithNativeFfmpeg(
      fs.readFileSync(input),
      path.extname(input).slice(1),
      target,
      { disableHwaccel: true, throwOnUnavailable: true, ...options },
      path.basename(input)
    );
    if (result === null || result.filePath === undefined) throw new Error('the engine returned no output file');
    return result;
  }

  const CODECS = [
    { codec: 'h264', target: 'mp4', encoder: 'libx264', reference: ['-c:v', 'libx264', '-preset', 'medium'], streamCodec: 'h264' },
    { codec: 'hevc', target: 'mp4', encoder: 'libx265', reference: ['-c:v', 'libx265', '-preset', 'medium', '-x265-params', 'log-level=error'], streamCodec: 'hevc' },
    {
      codec: 'vp9',
      target: 'webm',
      encoder: 'libvpx-vp9',
      reference: ['-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-tile-columns', '2', '-b:v', '0'],
      streamCodec: 'vp9',
    },
  ] as const;

  for (const row of CODECS) {
    oracleTest(
      `${row.codec}: no prober process, one encode, the picture the reference encoder writes at the same quality`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        requireEncoders(row.encoder, 'libopus');
        const source = plainMp4();
        const recorder = recordingBinaries(`plain-${row.codec}`);
        const result = await convert(source, row.target, recorder, { video: { codec: row.codec, rateControl: { mode: 'crf', crf: CRF } } });
        const written = result.filePath as string;

        const calls = recorder.calls();
        expect(calls.filter((call) => call.tool === 'ffprobe').map((call) => call.args.join(' '))).toEqual([]);
        const encodes = calls.filter((call) => call.tool === 'ffmpeg' && call.args.includes('-i'));
        expect(encodes).toHaveLength(1);
        expect(encodes[0].args).toContain(row.encoder);

        // Oracle one: the stream facts as ffprobe sees them.
        const probed = probeFile(tool('ffprobe'), written);
        expect(probed.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
          ['video', row.streamCodec],
          ['audio', row.target === 'webm' ? 'opus' : 'aac'],
        ]);

        // Oracle two: the reference encoder at the same settings. Same picture quality, same size.
        const reference = path.join(workDir, `reference-${row.codec}.${row.target}`);
        execFileSync(
          tool('ffmpeg'),
          ['-v', 'error', '-y', '-i', source, ...row.reference, '-crf', String(CRF), '-pix_fmt', 'yuv420p', '-an', reference],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        const ours = measureSsimPsnr(tool('ffmpeg'), written, source);
        const theirs = measureSsimPsnr(tool('ffmpeg'), reference, source);
        expect(ours.psnr).toBeGreaterThanOrEqual(theirs.psnr - PSNR_TOLERANCE_DB);
        expect(ours.ssim).toBeGreaterThanOrEqual(theirs.ssim - 0.001);
        expect(Math.abs(videoBytes(written) - videoBytes(reference)) / videoBytes(reference)).toBeLessThan(SIZE_TOLERANCE);
        fs.rmSync(written, { force: true });
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'a conversion that drops a stream still names it, with no prober process',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac', 'ac3');
      const source = make('two-audio.mp4', [
        ...VIDEO_IN, ...AUDIO_IN, ...AUDIO_IN, '-map', '0:v', '-map', '1:a', '-map', '2:a',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      ]);
      const recorder = recordingBinaries('plain-track');
      const result = await convert(source, 'mp4', recorder, { audio: { track: 1 } });
      expect(recorder.calls().filter((call) => call.tool === 'ffprobe')).toEqual([]);
      const kept = probeFile(tool('ffprobe'), result.filePath as string).streams.map((stream) => stream.codec_type);
      expect(kept).toEqual(['video', 'audio']);
      fs.rmSync(result.filePath as string, { force: true });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a PQ picture is still recognised from the header and refused when tone mapping is off',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264');
      const source = make('pq.mp4', [
        ...VIDEO_IN, '-vf', 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ]);
      // The oracle sees the same picture: PQ, which is what must keep this file out of an 8-bit conversion.
      expect(probeFile(tool('ffprobe'), source).streams[0]).toMatchObject({ codec_name: 'h264' });
      expect(execFileSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', source], { encoding: 'utf-8' }).trim()).toBe('smpte2084');
      const recorder = recordingBinaries('pq');
      await expect(convert(source, 'mp4', recorder, { toneMap: 'none' })).rejects.toBeInstanceOf(InvalidMediaOptionError);
      expect(recorder.calls().filter((call) => call.tool === 'ffprobe')).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});

describe('the tone mapping plan of an HDR picture', () => {
  /** An ffmpeg that lists a zscale filter its build may lack (the filter graph is only built here, never run). */
  function ffmpegListingZscale(): string {
    const dir = path.join(workDir, 'zscale-listing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ffmpeg'),
      `#!/bin/sh\nif [ "$1" = "-hide_banner" ] && [ "$2" = "-filters" ]; then printf ' ... zscale V->V Apply resizing.\\n'; exit 0; fi\nexec '${tool('ffmpeg')}' "$@"\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(dir, 'ffprobe'), `#!/bin/sh\nexec '${tool('ffprobe')}' "$@"\n`, { mode: 0o755 });
    return path.join(dir, 'ffmpeg');
  }

  function toneMapFilter(args: string[]): string {
    return args[args.indexOf('-vf') + 1];
  }

  oracleTest(
    'is the same whether the header or ffprobe says the picture is PQ',
    ['ffmpeg', 'ffprobe'],
    () => {
      requireEncoders('libx264');
      const mp4 = make('pq-plan.mp4', [
        ...VIDEO_IN, '-vf', 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ]);
      const mkv = make('pq-plan.mkv', ['-i', mp4, '-c', 'copy']);
      const ffmpeg = ffmpegListingZscale();
      const viaHeader = buildFfmpegArguments(mp4, path.join(workDir, 'o.mp4'), 'mp4', 'mp4', { disableHwaccel: true }, ffmpeg);
      const viaProbe = buildFfmpegArguments(mkv, path.join(workDir, 'o.mp4'), 'mkv', 'mp4', { disableHwaccel: true }, ffmpeg);
      expect(toneMapFilter(viaHeader)).toContain('zscale=t=linear');
      expect(toneMapFilter(viaHeader)).toBe(toneMapFilter(viaProbe));
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'is not built for an SDR picture',
    ['ffmpeg', 'ffprobe'],
    () => {
      const ffmpeg = ffmpegListingZscale();
      const args = buildFfmpegArguments(plainMp4(), path.join(workDir, 'o.mp4'), 'mp4', 'mp4', { disableHwaccel: true }, ffmpeg);
      // The picture is 160x120 and nothing changes its size: the encoder gets it as it is, through no filter at all.
      expect(args.filter((arg) => arg === '-vf' || arg === '-filter_complex')).toEqual([]);
      // The picture goes straight to the encoder in the one pixel format it is asked for.
      expect(args.slice(args.indexOf('-pix_fmt'), args.indexOf('-pix_fmt') + 4)).toEqual(['-pix_fmt', 'yuv420p', '-c:v', 'libx264']);
    },
    TEST_TIMEOUT_MS
  );
});

describe('the filter that keeps a picture size even', () => {
  function filterOf(args: string[]): string | undefined {
    const at = args.indexOf('-vf');
    return at === -1 ? undefined : args[at + 1];
  }

  /**
   * A picture of an odd size, in Matroska. Raw frames written here carry the size, because the ffmpeg sources that
   * make pictures round it to an even one on some builds and the H.264 and MPEG-4 encoders cut it.
   */
  function oddMkv(): string {
    const width = 161;
    const height = 121;
    const raw = path.join(workDir, 'odd.yuv');
    fs.writeFileSync(raw, Buffer.alloc(width * height * 3 * SECONDS * 24, 0x80));
    return make('odd.mkv', ['-f', 'rawvideo', '-pixel_format', 'yuv444p', '-video_size', `${width}x${height}`, '-framerate', '24', '-i', raw, '-c:v', 'ffv1']);
  }

  oracleTest(
    'is left out for a picture the header gives an even size and nothing resizes, and kept otherwise',
    ['ffmpeg', 'ffprobe'],
    () => {
      const out = path.join(workDir, 'o.mp4');
      expect(filterOf(buildFfmpegArguments(plainMp4(), out, 'mp4', 'mp4', { disableHwaccel: true }, tool('ffmpeg')))).toBeUndefined();
      // An odd picture is cut to an even size. The oracle first: the source really is odd.
      const odd = oddMkv();
      const oddFacts = probeFile(tool('ffprobe'), odd).streams[0];
      expect([oddFacts.width, oddFacts.height, oddFacts.pix_fmt]).toEqual([161, 121, 'yuv444p']);
      expect(filterOf(buildFfmpegArguments(oddMkv(), out, 'mkv', 'mp4', { disableHwaccel: true }, tool('ffmpeg')))).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
      // A resize, a crop or a display aspect may produce an odd size from an even one: the filter stays after them.
      const even = plainMp4();
      for (const options of [
        { video: { scale: { width: 101, height: 75 } } },
        { video: { crop: { w: 101, h: 75, x: 0, y: 0 } } },
        { videoResolution: '360p' },
      ]) {
        const filter = filterOf(buildFfmpegArguments(even, out, 'mp4', 'mp4', { disableHwaccel: true, ...options } as never, tool('ffmpeg')));
        expect(filter, JSON.stringify(options)).toMatch(/,scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2$/);
      }
    },
    TEST_TIMEOUT_MS
  );

  /**
   * The file with a clean aperture (`clap`) box appended to its H.264 sample entry: the picture is shown as `width` x
   * `height` out of the stored one. Every box on the way down to the entry grows by the box, and the movie box comes
   * after the media data in a file ffmpeg writes without faststart, so no sample offset moves.
   */
  function withCleanAperture(file: string, width: number, height: number, name: string): string {
    const bytes = fs.readFileSync(file);
    const clap = Buffer.alloc(8 + 32);
    clap.writeUInt32BE(clap.length, 0);
    clap.write('clap', 4, 'latin1');
    [width, 1, height, 1, 0, 1, 0, 1].forEach((value, i) => clap.writeUInt32BE(value, 8 + i * 4));
    const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
    const chain: number[] = [];
    let entryAt = -1;
    const walk = (start: number, end: number): boolean => {
      for (let at = start; at + 8 <= end; ) {
        const size = bytes.readUInt32BE(at);
        const type = bytes.toString('latin1', at + 4, at + 8);
        if (type === 'avc1') {
          entryAt = at;
          return true;
        }
        const inner = type === 'stsd' ? at + 16 : at + 8;
        if (containers.has(type) || type === 'stsd') {
          chain.push(at);
          if (walk(inner, at + size)) return true;
          chain.pop();
        }
        at += size;
      }
      return false;
    };
    if (!walk(0, bytes.length) || entryAt === -1) throw new Error('the file has no H.264 sample entry');
    const entryEnd = entryAt + bytes.readUInt32BE(entryAt);
    const patched = Buffer.concat([bytes.subarray(0, entryEnd), clap, bytes.subarray(entryEnd)]);
    for (const at of [...chain, entryAt]) patched.writeUInt32BE(patched.readUInt32BE(at) + clap.length, at);
    const out = path.join(workDir, name);
    fs.writeFileSync(out, patched);
    return out;
  }

  /** A 160x120 MP4 whose clean aperture is 159x119, which ffmpeg decodes to an odd (cut) picture. */
  function apertureMp4(): string {
    requireEncoders('libx264');
    const plain = make('aperture-plain.mp4', [...VIDEO_IN, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an']);
    return withCleanAperture(plain, 159, 119, 'aperture.mp4');
  }

  oracleTest(
    'is kept for a picture with a clean aperture, and the encode of it succeeds with an even picture',
    ['ffmpeg', 'ffprobe'],
    () => {
      const source = apertureMp4();
      // The oracle: ffprobe still lists the file as one picture and the aperture box really is in the file.
      expect(fs.readFileSync(source).includes('clap', 0, 'latin1')).toBe(true);
      const out = path.join(workDir, 'aperture-out.mp4');
      const args = buildFfmpegArguments(source, out, 'mp4', 'mp4', { disableHwaccel: true, video: { codec: 'h264', rateControl: { mode: 'crf', crf: CRF } } }, tool('ffmpeg'));
      expect(filterOf(args)).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
      execFileSync(tool('ffmpeg'), ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      const stream = probeFile(tool('ffprobe'), out).streams[0];
      expect(Number(stream.width) % 2).toBe(0);
      expect(Number(stream.height) % 2).toBe(0);
      // The written frames are as many as the source's and as large as the file says.
      const frames = execFileSync(tool('ffmpeg'), ['-v', 'error', '-i', out, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf-8' })
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('#'));
      expect(frames).toHaveLength(SECONDS * 24);
    },
    TEST_TIMEOUT_MS
  );

  it('is kept for a stream a prober lists with frame cropping side data', () => {
    const dir = path.join(workDir, 'fake-cropping');
    fs.mkdirSync(dir, { recursive: true });
    const report = JSON.stringify({
      streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 160, height: 120, side_data_list: [{ side_data_type: 'Frame Cropping', crop_right: 1, crop_bottom: 1 }] }],
      format: { start_time: '0.000000', duration: '1.000000' },
      chapters: [],
    });
    fs.writeFileSync(path.join(dir, 'ffprobe'), `#!/bin/sh\ncat <<'EOF'\n${report}\nEOF\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'ffmpeg'), `#!/bin/sh\nexec '${getOracleToolPath('ffmpeg') ?? 'ffmpeg'}' "$@"\n`, { mode: 0o755 });
    const input = path.join(workDir, 'cropped-stream.mkv');
    fs.writeFileSync(input, Buffer.alloc(64));
    const args = buildFfmpegArguments(input, path.join(workDir, 'o.mp4'), 'mkv', 'mp4', { disableHwaccel: true }, path.join(dir, 'ffmpeg'));
    expect(filterOf(args)).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  });

  oracleTest(
    'changes nothing in the picture: the encode without it decodes to the frames the same encode with it writes',
    ['ffmpeg', 'ffprobe'],
    () => {
      requireEncoders('libx264');
      const source = plainMp4();
      const without = path.join(workDir, 'even-without.mp4');
      const args = buildFfmpegArguments(source, without, 'mp4', 'mp4', { disableHwaccel: true, video: { codec: 'h264', rateControl: { mode: 'crf', crf: CRF } } }, tool('ffmpeg'));
      expect(args).not.toContain('-vf');
      execFileSync(tool('ffmpeg'), ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      const withFilter = path.join(workDir, 'even-with.mp4');
      const filtered = [...args.slice(0, -1)];
      filtered.splice(filtered.indexOf('-pix_fmt'), 0, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      execFileSync(tool('ffmpeg'), ['-v', 'error', ...filtered, withFilter], { stdio: ['ignore', 'ignore', 'pipe'] });
      const frames = (file: string): string =>
        execFileSync(tool('ffmpeg'), ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf-8' })
          .split('\n')
          .filter((line) => line !== '' && !line.startsWith('#'))
          .map((line) => line.split(',').slice(-1)[0].trim())
          .join('\n');
      expect(frames(without)).toBe(frames(withFilter));
      expect(frames(without).split('\n').length).toBe(SECONDS * 24);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'still gives an odd picture an even one in the written file',
    ['ffmpeg', 'ffprobe'],
    async () => {
      const out = path.join(workDir, 'odd-out.mp4');
      const args = buildFfmpegArguments(oddMkv(), out, 'mkv', 'mp4', { disableHwaccel: true, video: { codec: 'h264', rateControl: { mode: 'crf', crf: CRF } } }, tool('ffmpeg'));
      execFileSync(tool('ffmpeg'), ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      const stream = probeFile(tool('ffprobe'), out).streams[0];
      expect([stream.width, stream.height]).toEqual([160, 120]);
    },
    TEST_TIMEOUT_MS
  );
});

describe('conversions of an input the header cannot describe', () => {
  const previousFfmpeg = process.env.FFMPEG_PATH;
  afterAll(() => {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previousFfmpeg;
  });

  oracleTest(
    'one prober process answers the stream list, the timeline, the transfer, the duration and the dropped streams',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac');
      const source = make('plain.mkv', [...VIDEO_IN, ...AUDIO_IN, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
      const recorder = recordingBinaries('mkv');
      process.env.FFMPEG_PATH = recorder.ffmpeg;
      const result = await convertWithNativeFfmpeg(fs.readFileSync(source), 'mkv', 'mp4', { disableHwaccel: true, throwOnUnavailable: true }, 'plain.mkv');
      expect(result?.filePath).toBeDefined();
      const calls = recorder.calls();
      expect(calls.filter((call) => call.tool === 'ffprobe')).toHaveLength(1);
      expect(calls.filter((call) => call.tool === 'ffmpeg' && call.args.includes('-i'))).toHaveLength(1);
      fs.rmSync(result?.filePath as string, { force: true });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'an H.265 MP4 is probed once, not once per question',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx265', 'aac');
      const source = make('hevc.mp4', [
        ...VIDEO_IN, ...AUDIO_IN, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', '-c:a', 'aac', '-shortest',
      ]);
      const recorder = recordingBinaries('hevc-src');
      process.env.FFMPEG_PATH = recorder.ffmpeg;
      const result = await convertWithNativeFfmpeg(fs.readFileSync(source), 'mp4', 'mp4', { disableHwaccel: true, throwOnUnavailable: true }, 'hevc.mp4');
      expect(recorder.calls().filter((call) => call.tool === 'ffprobe')).toHaveLength(1);
      fs.rmSync(result?.filePath as string, { force: true });
    },
    TEST_TIMEOUT_MS
  );
});

describe('the duration that bounds a job', () => {
  oracleTest(
    'comes from the movie header of a plain MP4 and agrees with ffprobe',
    ['ffmpeg', 'ffprobe'],
    () => {
      const source = plainMp4();
      const recorder = recordingBinaries('duration');
      const reported = Number(
        execFileSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', source], { encoding: 'utf-8' })
      );
      const before = recorder.calls().length;
      expect(Math.abs(probeMediaDuration(source, {}, recorder.ffmpeg) - reported)).toBeLessThan(DURATION_TOLERANCE_S);
      expect(recorder.calls().length).toBe(before);
    },
    TEST_TIMEOUT_MS
  );
});

describe('the arguments of a plain MP4 to H.264 conversion', () => {
  oracleTest(
    'map the picture and the sound the header lists and add no argument for streams that do not exist',
    ['ffmpeg', 'ffprobe'],
    () => {
      const source = plainMp4();
      const args = buildFfmpegArguments(source, path.join(workDir, 'o.mp4'), 'mp4', 'mp4', { disableHwaccel: true }, tool('ffmpeg'));
      const maps = args.flatMap((arg, i) => (arg === '-map' ? [args[i + 1]] : []));
      expect(maps).toEqual(['0:0', '0:1']);
      expect(args).toContain('libx264');
      expect(args).not.toContain('-c:s');
    }
  );

  it('are built for an input that is not there without asking for streams', () => {
    const absent = path.join(workDir, 'absent.mp4');
    const args = buildFfmpegArguments(absent, path.join(workDir, 'o.mp4'), 'mp4', 'mp4', { disableHwaccel: true }, null);
    expect(args.slice(0, args.indexOf('-i') + 2)).toEqual(['-y', '-i', absent]);
    expect(args.filter((arg) => arg === '-map')).toEqual([]);
  });
});

describe('the hardware encoder probe of a video conversion', () => {
  /**
   * A sibling pair whose ffmpeg lists NVENC on top of the real encoder list and logs every call, as the Ubuntu build
   * does. A host with no GPU still has to start a process to learn that no session opens, so the count is the point.
   */
  function nvencListingBinaries(label: string): { ffmpeg: string; sessionProbes: () => number; encoderLists: () => number } {
    const dir = path.join(workDir, `nvenc-listing-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(log, '');
    const real = tool('ffmpeg');
    const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase " $* " in\n  *" -encoders "*) '${real}' "$@"; printf ' V....D h264_nvenc NVIDIA NVENC H.264 encoder\\n'; exit 0;;\nesac\nexec '${real}' "$@"\n`;
    fs.writeFileSync(path.join(dir, 'ffmpeg'), script, { mode: 0o755 });
    fs.symlinkSync(tool('ffprobe'), path.join(dir, 'ffprobe'));
    const lines = () => fs.readFileSync(log, 'utf-8').split('\n').filter((line) => line !== '');
    return {
      ffmpeg: path.join(dir, 'ffmpeg'),
      sessionProbes: () => lines().filter((line) => line.includes('lavfi') && line.includes('h264_nvenc')).length,
      encoderLists: () => lines().filter((line) => line.includes('-encoders')).length,
    };
  }

  oracleTest(
    'a request that disables hardware encoders opens no hardware session',
    ['ffmpeg', 'ffprobe'],
    () => {
      resetHardwareAccelerationCache();
      const source = plainMp4();
      const binaries = nvencListingBinaries('disabled');
      const args = buildFfmpegArguments(source, path.join(workDir, 'hw-off.mp4'), 'mp4', 'mp4', { disableHwaccel: true }, binaries.ffmpeg);
      expect(args).toContain('libx264');
      expect(binaries.sessionProbes()).toBe(0);
      resetHardwareAccelerationCache();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'opens each hardware session once per binary, however many conversions follow',
    ['ffmpeg', 'ffprobe'],
    () => {
      resetHardwareAccelerationCache();
      const source = plainMp4();
      const binaries = nvencListingBinaries('enabled');
      for (let conversion = 0; conversion < 3; conversion++) {
        buildFfmpegArguments(source, path.join(workDir, `hw-on-${conversion}.mp4`), 'mp4', 'mp4', {}, binaries.ffmpeg);
      }
      expect(binaries.sessionProbes()).toBe(1);
      expect(binaries.encoderLists()).toBe(1);
      resetHardwareAccelerationCache();
    },
    TEST_TIMEOUT_MS
  );
});
