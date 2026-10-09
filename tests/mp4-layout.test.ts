import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMp4Layout } from '../src/lib/conversions/mp4-layout';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { oracleTest } from './helpers/oracle-test';

/**
 * The header reader answers which streams an MP4 or MOV holds, what each one is, and the transfer characteristic of
 * its picture, without a prober process. It is judged against ffprobe on files the reference ffmpeg wrote: every
 * input it answers for must give the facts ffprobe gives, and every shape it cannot answer exactly must be left to
 * ffprobe (null), never guessed.
 */

const TEST_TIMEOUT_MS = 180_000;
const SIZE = '64x48';
const SECONDS = 0.5;
const TONE_HZ = 440;
const COVER_SIZE = 16;
const DURATION_TOLERANCE_S = 0.1;

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-layout-'));
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
const PQ_TRANSFER_CODE = 16;
const BT709_TRANSFER_CODE = 1;
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast'];

/** `setparams` options that tag the frames, which the encoder writes into the stream and the container. */
function tagged(transfer: string, primaries: string): string {
  return `color_trc=${transfer}:color_primaries=${primaries}:colorspace=${primaries === 'bt709' ? 'bt709' : 'bt2020nc'}`;
}

/** Transfer codes (ISO/IEC 23091-2) of the `nclx` colour boxes in a file, read from its bytes and not from any prober. */
function nclxTransferCodes(file: string): number[] {
  const bytes = fs.readFileSync(file);
  const codes: number[] = [];
  for (let at = bytes.indexOf('colrnclx', 0, 'latin1'); at !== -1; at = bytes.indexOf('colrnclx', at + 1, 'latin1')) {
    // colr, nclx, then the primaries, the transfer and the matrix as 16-bit codes.
    codes.push(bytes.readUInt16BE(at + 'colrnclx'.length + 2));
  }
  return codes;
}

/** Writes `name` with ffmpeg run on `args` and returns its path. */
function make(name: string, args: string[]): string {
  const out = path.join(workDir, name);
  execFileSync(tool('ffmpeg'), ['-v', 'error', '-y', ...args, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

interface Fact {
  index: number;
  type: string;
  codecName: string;
  language?: string;
  colorTransfer?: string;
  width?: number;
  height?: number;
}

/** What ffprobe reports for each stream, reduced to the facts the reader answers. */
function referenceFacts(file: string): { streams: Fact[]; chapters: number; durationSec: number } {
  const report = JSON.parse(
    execFileSync(tool('ffprobe'), ['-v', 'error', '-show_streams', '-show_entries', 'format=duration:chapter=id', '-of', 'json', file], {
      encoding: 'utf-8',
    })
  ) as { streams: Record<string, unknown>[]; chapters?: unknown[]; format: { duration: string } };
  return {
    chapters: report.chapters?.length ?? 0,
    durationSec: Number(report.format.duration),
    streams: report.streams.map((raw) => {
      const tags = (raw.tags ?? {}) as Record<string, string>;
      const fact: Fact = { index: raw.index as number, type: raw.codec_type as string, codecName: raw.codec_name as string };
      if (tags.language !== undefined) fact.language = tags.language;
      if (raw.codec_type === 'video' && typeof raw.color_transfer === 'string') fact.colorTransfer = raw.color_transfer;
      if (raw.codec_type === 'video') {
        fact.width = raw.width as number;
        fact.height = raw.height as number;
      }
      return fact;
    }),
  };
}

function layoutFacts(file: string): Fact[] | null {
  const layout = readMp4Layout(file);
  if (layout === null) return null;
  return layout.streams.map((stream) => {
    const fact: Fact = { index: stream.index, type: stream.type, codecName: stream.codecName };
    if (stream.language !== undefined) fact.language = stream.language;
    if (stream.type === 'video' && stream.colorTransfer !== undefined) fact.colorTransfer = stream.colorTransfer;
    if (stream.type === 'video') {
      fact.width = stream.width;
      fact.height = stream.height;
    }
    return fact;
  });
}

describe('inputs the header reader answers exactly', () => {
  const CASES: { name: string; build: () => string; expectedTransfer?: string }[] = [
    { name: 'H.264 video only', build: () => make('video.mp4', [...VIDEO_IN, ...H264]) },
    { name: 'H.264 with AAC', build: () => make('av.mp4', [...VIDEO_IN, ...AUDIO_IN, ...H264, '-c:a', 'aac', '-shortest']) },
    {
      name: 'H.264 with moov first (faststart)',
      build: () => make('fast.mp4', [...VIDEO_IN, ...AUDIO_IN, ...H264, '-c:a', 'aac', '-movflags', '+faststart', '-shortest']),
    },
    {
      name: 'H.264 with two audio tracks (AAC, MP3)',
      build: () =>
        make('two-audio.mp4', [...VIDEO_IN, ...AUDIO_IN, ...AUDIO_IN, ...H264, '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:a:0', 'aac', '-c:a:1', 'libmp3lame', '-shortest']),
    },
    { name: 'H.264 with AC-3', build: () => make('ac3.mp4', [...VIDEO_IN, ...AUDIO_IN, ...H264, '-c:a', 'ac3', '-shortest']) },
    { name: 'H.264 with Opus', build: () => make('opus.mp4', [...VIDEO_IN, ...AUDIO_IN, ...H264, '-c:a', 'libopus', '-strict', '-2', '-shortest']) },
    {
      name: 'H.264 whose size is not a multiple of 16 (cropped in the stream)',
      build: () => make('cropped.mp4', [...VIDEO_IN, '-vf', 'scale=98:58', ...H264]),
    },
    { name: 'AAC audio only (m4a)', build: () => make('audio.m4a', [...AUDIO_IN, '-c:a', 'aac']) },
    { name: 'a QuickTime file', build: () => make('av.mov', [...VIDEO_IN, ...AUDIO_IN, ...H264, '-c:a', 'aac', '-shortest']) },
    {
      name: 'a PQ picture tagged in both the container and the stream',
      expectedTransfer: 'smpte2084',
      build: () => make('pq.mp4', [...VIDEO_IN, '-vf', `setparams=${tagged('smpte2084', 'bt2020')}`, ...H264]),
    },
    {
      name: 'an HLG picture tagged in both the container and the stream',
      expectedTransfer: 'arib-std-b67',
      build: () => make('hlg.mp4', [...VIDEO_IN, '-vf', `setparams=${tagged('arib-std-b67', 'bt2020')}`, ...H264]),
    },
    {
      name: 'a BT.709 picture tagged in both the container and the stream',
      expectedTransfer: 'bt709',
      build: () => make('709.mp4', [...VIDEO_IN, '-vf', `setparams=${tagged('bt709', 'bt709')}`, ...H264]),
    },
    {
      name: 'a PQ picture signalled only in the H.264 stream',
      expectedTransfer: 'smpte2084',
      build: () => make('pq-stream.mp4', [...VIDEO_IN, ...H264, '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']),
    },
    {
      name: 'an HLG picture signalled only in the H.264 stream',
      expectedTransfer: 'arib-std-b67',
      build: () => make('hlg-stream.mp4', [...VIDEO_IN, ...H264, '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc']),
    },
  ];

  for (const { name, build, expectedTransfer } of CASES) {
    oracleTest(
      `${name}: the same streams, codecs, languages and transfer as ffprobe`,
      ['ffmpeg', 'ffprobe'],
      () => {
        requireEncoders('libx264', 'aac', 'libmp3lame', 'ac3', 'libopus');
        const file = build();
        const reference = referenceFacts(file);
        // The oracle itself must see the transfer the case is about, or agreeing with it proves nothing.
        expect(reference.streams.find((stream) => stream.type === 'video')?.colorTransfer).toBe(expectedTransfer);
        expect(layoutFacts(file)).toEqual(reference.streams);
        expect(reference.chapters).toBe(0);
        // The movie header's length is what bounds a job's run time; it must agree with the prober's to a few frames.
        expect(Math.abs((readMp4Layout(file)?.durationSec ?? Number.NaN) - reference.durationSec)).toBeLessThan(DURATION_TOLERANCE_S);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'an H.264 stream with a high bit depth is answered with the transfer of its stream',
    ['ffmpeg', 'ffprobe'],
    () => {
      requireEncoders('libx264');
      const file = make('ten-bit.mp4', [
        ...VIDEO_IN, '-vf', `setparams=${tagged('smpte2084', 'bt2020')}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast',
      ]);
      const reference = referenceFacts(file).streams;
      expect(reference[0].colorTransfer).toBe('smpte2084');
      expect(layoutFacts(file)).toEqual(reference);
    },
    TEST_TIMEOUT_MS
  );
});

describe('inputs left to ffprobe', () => {
  const CASES: { name: string; build: () => string }[] = [
    { name: 'an H.265 picture', build: () => make('hevc.mp4', [...VIDEO_IN, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-x265-params', 'log-level=error']) },
    { name: 'a VP9 picture', build: () => make('vp9.mp4', [...VIDEO_IN, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8']) },
    { name: 'a fragmented file', build: () => make('frag.mp4', [...VIDEO_IN, ...H264, '-movflags', '+frag_keyframe+empty_moov']) },
    {
      name: 'a file with chapters',
      build: () => {
        const meta = path.join(workDir, 'chapters.ffmetadata');
        fs.writeFileSync(meta, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=250\ntitle=A\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=250\nEND=500\ntitle=B\n');
        return make('chapters.mp4', [...VIDEO_IN, '-i', meta, '-map_metadata', '1', '-map_chapters', '1', ...H264]);
      },
    },
    {
      name: 'a file with cover art',
      build: () => {
        const cover = make('cover.png', ['-f', 'lavfi', '-i', `color=c=red:s=${COVER_SIZE}x${COVER_SIZE}`, '-frames:v', '1']);
        return make('cover.m4a', [...AUDIO_IN, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v', 'attached_pic']);
      },
    },
    {
      name: 'a file with a subtitle track',
      build: () => {
        const srt = path.join(workDir, 'sub.srt');
        fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:00,400\nhello\n');
        return make('sub.mp4', [...VIDEO_IN, '-i', srt, ...H264, '-c:s', 'mov_text']);
      },
    },
    { name: 'a Matroska file', build: () => make('plain.mkv', [...VIDEO_IN, ...H264]) },
  ];

  for (const { name, build } of CASES) {
    oracleTest(`${name} gets no answer`, ['ffmpeg', 'ffprobe'], () => {
      requireEncoders('libx264', 'libx265', 'libvpx-vp9', 'aac');
      expect(readMp4Layout(build())).toBeNull();
    }, TEST_TIMEOUT_MS);
  }

  it('gives no answer for a file that is not there, an empty file or text', () => {
    expect(readMp4Layout(path.join(workDir, 'absent.mp4'))).toBeNull();
    const empty = path.join(workDir, 'empty.mp4');
    fs.writeFileSync(empty, '');
    expect(readMp4Layout(empty)).toBeNull();
    const text = path.join(workDir, 'text.mp4');
    fs.writeFileSync(text, 'not a media file at all, only text that is long enough to hold a box header');
    expect(readMp4Layout(text)).toBeNull();
  });

  oracleTest(
    'gives no answer for a file cut off inside its sample tables',
    ['ffmpeg', 'ffprobe'],
    () => {
      requireEncoders('libx264');
      const whole = fs.readFileSync(make('whole.mp4', [...VIDEO_IN, ...H264]));
      const cut = path.join(workDir, 'cut.mp4');
      for (const keep of [whole.length - 1, whole.length - 40, whole.length - 200]) {
        fs.writeFileSync(cut, whole.subarray(0, keep));
        expect(readMp4Layout(cut)).toBeNull();
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'gives no answer when the container says PQ and the stream says BT.709',
    ['ffmpeg', 'ffprobe'],
    () => {
      requireEncoders('libx264');
      const both = make('pq-for-conflict.mp4', [...VIDEO_IN, '-vf', `setparams=${tagged('smpte2084', 'bt2020')}`, ...H264]);
      const file = make('pq-vs-709.mp4', ['-i', both, '-c', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1']);
      expect(readMp4Layout(file)).toBeNull();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'gives no answer when only the container states the transfer',
    ['ffmpeg'],
    () => {
      requireEncoders('libx264');
      const both = make('pq-both.mp4', [...VIDEO_IN, '-vf', `setparams=${tagged('smpte2084', 'bt2020')}`, ...H264]);
      const file = make('pq-container.mp4', ['-i', both, '-c', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2']);
      // ffprobe 6.1 reports no transfer for this file and ffprobe 7 and later report PQ, so the reader declines.
      expect(nclxTransferCodes(file)).toEqual([PQ_TRANSFER_CODE]);
      expect(readMp4Layout(file)).toBeNull();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'gives no answer when the container tag and the stream tag of the transfer disagree',
    ['ffmpeg'],
    () => {
      requireEncoders('libx264');
      // The stream states PQ in its parameter sets. The box ffmpeg writes depends on its release, so the container's
      // statement is set here, in the bytes: BT.709 in the primaries, the transfer and the matrix.
      const file = make('conflict.mp4', [
        ...VIDEO_IN, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
        '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-movflags', '+write_colr',
      ]);
      const bytes = fs.readFileSync(file);
      const box = bytes.indexOf('colrnclx', 0, 'latin1');
      expect(box).not.toBe(-1);
      for (const field of [0, 1, 2]) bytes.writeUInt16BE(BT709_TRANSFER_CODE, box + 'colrnclx'.length + field * 2);
      fs.writeFileSync(file, bytes);
      // The container states BT.709 and the stream PQ. ffprobe 6.1 answers with the stream's statement and ffprobe 7
      // and later with none, so the reader must not pick one: it declines and the caller asks ffprobe.
      expect(nclxTransferCodes(file)).toEqual([BT709_TRANSFER_CODE]);
      expect(readMp4Layout(file)).toBeNull();
    },
    TEST_TIMEOUT_MS
  );
});
