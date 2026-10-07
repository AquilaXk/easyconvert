import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { demuxMp4, MP4_MAX_SAMPLES_PER_TRACK, MP4_MAX_TOTAL_SAMPLES } from '../src/lib/edge/media/iso-bmff-demux';
import type { DemuxedMediaSample, DemuxedTrackInfo } from '../src/lib/edge/media/media-types';
import { demuxWav } from '../src/lib/edge/media/wav-demux';
import { demuxMedia } from '../src/lib/edge/workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { getOracleToolPath } from './helpers/differential-oracle';
import {
  h264AacMp4,
  requireEncoders,
  runFfmpeg,
  sineInput,
  testPatternInput,
} from './helpers/ffmpeg-media-fixtures';
import {
  avcProfileAndLevelHex,
  ffprobeReport,
  type FfprobePacket,
  type FfprobeStream,
} from './helpers/ffprobe-json';
import { findPath, listBoxes, payloadOf, walkTracks, type IsoBox } from './helpers/iso-bmff-walker';
import { ffprobeFrameCount } from './helpers/ffprobe-frames';
import { oracleTest } from './helpers/oracle-test';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

const MICROS = 1_000_000;
const ONE_MICRO = 1;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function crcLabel(bytes: Uint8Array): string {
  return `CRC32:${crc32(bytes).toString(16).padStart(8, '0')}`;
}

function streamOf(report: ReturnType<typeof ffprobeReport>, type: 'video' | 'audio'): FfprobeStream {
  const stream = report.streams.find((candidate) => candidate.codec_type === type);
  if (!stream) throw new Error(`reference probe found no ${type} stream`);
  return stream;
}

function packetsOf(report: ReturnType<typeof ffprobeReport>, stream: FfprobeStream): FfprobePacket[] {
  return report.packets.filter((packet) => packet.stream_index === stream.index);
}

/** Every sample must equal the reference packet in size, bytes, presentation time, duration and key flag. */
function expectSamplesMatchPackets(samples: DemuxedMediaSample[], packets: FfprobePacket[]): void {
  expect(samples).toHaveLength(packets.length);
  packets.forEach((packet, index) => {
    const sample = samples[index];
    expect(sample.data.byteLength).toBe(Number(packet.size));
    expect(crcLabel(sample.data)).toBe(packet.data_hash);
    expect(Math.abs(sample.timestampMicros - Math.round(Number(packet.pts_time) * MICROS))).toBeLessThanOrEqual(ONE_MICRO);
    expect(sample.isKeyFrame).toBe(packet.flags.startsWith('K'));
    if (packet.duration_time !== undefined) {
      expect(Math.abs((sample.durationMicros ?? Number.NaN) - Math.round(Number(packet.duration_time) * MICROS))).toBeLessThanOrEqual(
        ONE_MICRO
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Reference-authored MP4 fixtures
// ---------------------------------------------------------------------------------------------------

describe('demuxMp4 against ffprobe -show_packets -show_streams', () => {
  for (const faststart of [false, true]) {
    oracleTest(
      `reads H.264 with B-frames plus AAC (faststart=${faststart}): counts, sizes, bytes, times, keys, codec strings`,
      ['ffmpeg', 'ffprobe'],
      () => {
        const mp4 = h264AacMp4(faststart ? ['-movflags', '+faststart'] : []);
        const report = ffprobeReport(mp4, 'mp4');
        const video = streamOf(report, 'video');
        const audio = streamOf(report, 'audio');

        const track = demuxMp4(toArrayBuffer(mp4));

        // The reference decodes frames out of order: some pts precede an earlier packet's pts
        const videoPackets = packetsOf(report, video);
        expect(videoPackets.some((p, i) => i > 0 && Number(p.pts_time) < Number(videoPackets[i - 1].pts_time))).toBe(true);

        expect(track.type).toBe('video');
        expectSamplesMatchPackets(track.samples, videoPackets);
        expect(track.width).toBe(video.width);
        expect(track.height).toBe(video.height);
        const { profileIdc, level } = avcProfileAndLevelHex(video);
        expect(track.codec).toMatch(new RegExp(`^avc1\\.${profileIdc}[0-9a-f]{2}${level}$`));
        expect(track.description?.byteLength).toBe(video.extradata_size);

        expect(track.audioTrack).toBeDefined();
        const audioTrack = track.audioTrack as DemuxedTrackInfo;
        expectSamplesMatchPackets(audioTrack.samples, packetsOf(report, audio));
        expect(audioTrack.codec).toBe('mp4a.40.2');
        expect(audio.profile).toBe('LC');
        expect(String(audioTrack.sampleRate)).toBe(audio.sample_rate);
        expect(audioTrack.channels).toBe(audio.channels);
        expect(audioTrack.description?.byteLength).toBe(audio.extradata_size);
      }
    );
  }

  oracleTest('reads an AAC-only m4a', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('aac');
    const m4a = runFfmpeg([...sineInput(48000, 2), '-ac', '2', '-c:a', 'aac', '-f', 'ipod'], 'm4a');
    const report = ffprobeReport(m4a, 'm4a');
    const audio = streamOf(report, 'audio');

    const track = demuxMp4(toArrayBuffer(m4a));

    expect(track.type).toBe('audio');
    expect(track.codec).toBe('mp4a.40.2');
    expect(track.sampleRate).toBe(48000);
    expect(track.channels).toBe(2);
    expectSamplesMatchPackets(track.samples, packetsOf(report, audio));
  });

  oracleTest('reads variable frame durations from several stts entries', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libx264');
    const mp4 = runFfmpeg(
      [
        ...testPatternInput({ width: 160, height: 120, fps: 30, seconds: 2 }),
        '-vf', "select='lt(mod(n,10),7)'",
        '-fps_mode', 'vfr',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0',
      ],
      'mp4'
    );
    const report = ffprobeReport(mp4, 'mp4');
    const video = streamOf(report, 'video');
    const packets = packetsOf(report, video);
    const durations = new Set(packets.map((p) => p.duration));
    expect(durations.size).toBeGreaterThan(1);

    expectSamplesMatchPackets(demuxMp4(toArrayBuffer(mp4)).samples, packets);
  });

  oracleTest('applies the initial empty edit of a delayed track', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libx264');
    const mp4 = runFfmpeg(
      [
        ...testPatternInput({ width: 160, height: 120, fps: 25, seconds: 1 }),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0',
        '-output_ts_offset', '0.5',
      ],
      'mp4'
    );
    // The fixture really carries a leading empty edit: elst entry 0 has media_time -1 (ISO/IEC 14496-12 8.6.6)
    const bytes = new Uint8Array(mp4);
    const elst = findPath(bytes, listBoxes(bytes), ['moov', 'trak', 'edts', 'elst'])[0];
    expect(new DataView(bytes.buffer, bytes.byteOffset).getInt32(elst.payloadStart + 8 + 4)).toBe(-1);
    const report = ffprobeReport(mp4, 'mp4');
    const video = streamOf(report, 'video');
    const packets = packetsOf(report, video);
    expect(Number(packets[0].pts_time)).toBeCloseTo(0.5, 3);

    expectSamplesMatchPackets(demuxMp4(toArrayBuffer(mp4)).samples, packets);
  });

  oracleTest('reads a VP9 track with the vp09 string of its vpcC', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libvpx-vp9');
    const mp4 = runFfmpeg(
      [
        ...testPatternInput({ width: 160, height: 120, fps: 25, seconds: 1 }),
        '-c:v', 'libvpx-vp9', '-b:v', '100k', '-pix_fmt', 'yuv420p', '-f', 'mp4',
      ],
      'mp4'
    );
    const report = ffprobeReport(mp4, 'mp4');
    const video = streamOf(report, 'video');
    const entry = walkTracks(new Uint8Array(mp4))[0].entries[0];
    expect(entry.type).toBe('vp09');
    const vpcC = entry.children.find((box) => box.type === 'vpcC') as IsoBox;
    const body = payloadOf(new Uint8Array(mp4), vpcC);
    // VP Codec ISO Media File Format Binding 2.2: version, flags, profile, level, depth|chroma|range, cp, tc, mc
    const [profile, level, packed, primaries, transfer, matrix] = [body[4], body[5], body[6], body[7], body[8], body[9]];
    const two = (n: number): string => String(n).padStart(2, '0');
    expect(video.profile).toBe(`Profile ${profile}`);

    const track = demuxMp4(toArrayBuffer(mp4));

    expect(track.codec).toBe(
      `vp09.${two(profile)}.${two(level)}.${two(packed >> 4)}.${two((packed >> 1) & 7)}.${two(primaries)}.${two(transfer)}.${two(matrix)}.${two(packed & 1)}`
    );
    expect(track.description).toBeUndefined();
    expectSamplesMatchPackets(track.samples, packetsOf(report, video));
  });

  oracleTest('reads an AV1 track with the av01 string of its av1C', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libaom-av1');
    const mp4 = runFfmpeg(
      [
        ...testPatternInput({ width: 160, height: 120, fps: 25, seconds: 1 }),
        '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '45', '-b:v', '0', '-pix_fmt', 'yuv420p', '-f', 'mp4',
      ],
      'mp4'
    );
    const report = ffprobeReport(mp4, 'mp4');
    const video = streamOf(report, 'video');
    const entry = walkTracks(new Uint8Array(mp4))[0].entries[0];
    expect(entry.type).toBe('av01');
    const av1C = payloadOf(new Uint8Array(mp4), entry.children.find((box) => box.type === 'av1C') as IsoBox);
    // AV1 ISOBMFF binding 2.3.3: marker|version, profile|level, tier|high_bitdepth|twelve_bit|...
    const profile = av1C[1] >> 5;
    const level = av1C[1] & 0x1f;
    const tier = (av1C[2] & 0x80) === 0 ? 'M' : 'H';
    const depth = (av1C[2] & 0x40) === 0 ? '08' : '10';

    const track = demuxMp4(toArrayBuffer(mp4));

    expect(track.codec).toBe(`av01.${profile}.${String(level).padStart(2, '0')}${tier}.${depth}`);
    expect(video.codec_name).toBe('av1');
    expectSamplesMatchPackets(track.samples, packetsOf(report, video));
  });

  oracleTest('reads an HEVC track with the hvc1 string of its hvcC', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libx265');
    const mp4 = runFfmpeg(
      [
        ...testPatternInput({ width: 160, height: 120, fps: 25, seconds: 1 }),
        '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-f', 'mp4',
      ],
      'mp4'
    );
    const report = ffprobeReport(mp4, 'mp4');
    const video = streamOf(report, 'video');
    const entry = walkTracks(new Uint8Array(mp4))[0].entries[0];
    expect(entry.type).toBe('hvc1');
    const hvcC = payloadOf(new Uint8Array(mp4), entry.children.find((box) => box.type === 'hvcC') as IsoBox);
    // ISO/IEC 14496-15 E.3: profile_space|tier|profile_idc, compatibility flags (bit-reversed), level, constraints
    const profileSpace = ['', 'A', 'B', 'C'][hvcC[1] >> 6];
    const profileIdc = hvcC[1] & 0x1f;
    let compat = 0;
    for (let bit = 0; bit < 32; bit++) {
      const source = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
      if ((source >>> bit) & 1) compat |= 1 << (31 - bit);
    }
    const tier = (hvcC[1] & 0x20) === 0 ? 'L' : 'H';
    const constraints = [...hvcC.subarray(6, 12)];
    while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
    const expected = [
      `hvc1.${profileSpace}${profileIdc}`,
      (compat >>> 0).toString(16),
      `${tier}${hvcC[12]}`,
      ...constraints.map((byte) => byte.toString(16).toUpperCase()),
    ].join('.');

    const track = demuxMp4(toArrayBuffer(mp4));

    expect(video.profile).toBe('Main');
    expect(profileIdc).toBe(1);
    expect(track.codec).toBe(expected);
    expect(track.description).toEqual(new Uint8Array(hvcC));
    expectSamplesMatchPackets(track.samples, packetsOf(report, video));
  });

  oracleTest('reads MP3 carried in MP4 as an mp3 track', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libmp3lame');
    const mp4 = runFfmpeg([...sineInput(44100, 2), '-c:a', 'libmp3lame', '-f', 'mp4'], 'mp4');
    const report = ffprobeReport(mp4, 'mp4');
    const audio = streamOf(report, 'audio');

    const track = demuxMp4(toArrayBuffer(mp4));

    expect(audio.codec_name).toBe('mp3');
    expect(track.codec).toBe('mp3');
    expect(String(track.sampleRate)).toBe(audio.sample_rate);
    expect(track.channels).toBe(audio.channels);
    expectSamplesMatchPackets(track.samples, packetsOf(report, audio));
  });

  oracleTest('refuses Opus in MP4 rather than guessing a decoder configuration', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libopus');
    const mp4 = runFfmpeg([...sineInput(48000, 1), '-c:a', 'libopus', '-f', 'mp4'], 'mp4');

    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(EdgeUnsupportedError);
    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(/Opus/);
  });

  oracleTest('refuses an edit list that cuts the media short, which the reference presents as fewer frames', ['ffmpeg', 'ffprobe'], () => {
    const mp4 = new Uint8Array(h264AacMp4());
    const full = ffprobeFrameCount(Buffer.from(mp4), 'mp4');
    const elst = findPath(mp4, listBoxes(mp4), ['moov', 'trak', 'edts', 'elst'])[0];
    // elst version 0: version/flags, entry_count, then (segment_duration, media_time, rate) per entry; the movie
    // timescale is 1000, so 500 cuts the 2 s video track to its first half second
    const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
    expect(view.getUint32(elst.payloadStart + 4)).toBe(1);
    view.setUint32(elst.payloadStart + 8, 500);

    expect(ffprobeFrameCount(Buffer.from(mp4), 'mp4')).toBeLessThan(full / 2);
    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(EdgeUnsupportedError);
    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(/edit list presents 500 ms of a video track that has \d+ ms/);
  });

  oracleTest('reads an unpatched file whose edit list covers the media, audio padding included', ['ffmpeg', 'ffprobe'], () => {
    expect(demuxMp4(toArrayBuffer(h264AacMp4())).samples).toHaveLength(50);
  });

  oracleTest('refuses a rotated video, whose display transform the edge would drop', ['ffmpeg', 'ffprobe'], () => {
    const mp4 = new Uint8Array(h264AacMp4());
    const tkhd = findPath(mp4, listBoxes(mp4), ['moov', 'trak', 'tkhd'])[0];
    // ISO/IEC 14496-12 8.3.2: in a version 0 tkhd the matrix starts 40 bytes into the payload.
    // Rotate by 90 degrees: a = 0, b = 1, c = -1, d = 0.
    const TKHD_V0_MATRIX_OFFSET = 40;
    const matrixAt = tkhd.payloadStart + TKHD_V0_MATRIX_OFFSET;
    const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
    view.setInt32(matrixAt, 0);
    view.setInt32(matrixAt + 4, 0x10000);
    view.setInt32(matrixAt + 12, -0x10000);
    view.setInt32(matrixAt + 16, 0);

    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(/display transform/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Hand-assembled MP4s: the expected values follow from the bytes that are written
// ---------------------------------------------------------------------------------------------------

function be16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function be64(n: number): number[] {
  return [...be32(Math.floor(n / 2 ** 32)), ...be32(n >>> 0)];
}
/** Big-endian 32-bit integers packed without spreading them into call arguments. */
function packU32(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return out;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}
function cat(...parts: Array<number[] | Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function box(type: string, ...payload: Array<number[] | Uint8Array>): Uint8Array {
  const body = cat(...payload);
  return cat(be32(8 + body.byteLength), ascii(type), body);
}
function fullBox(type: string, version: number, flags: number, ...payload: Array<number[] | Uint8Array>): Uint8Array {
  return box(type, [version], [(flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff], ...payload);
}

const SPS = [0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
const AVCC = [1, 0x64, 0x00, 0x1f, 0xff, 0xe1, ...be16(SPS.length), ...SPS, 1, ...be16(PPS.length), ...PPS];
/** AudioSpecificConfig: AAC LC, 44.1 kHz, stereo. */
const ASC_LC_44100_STEREO = [0x12, 0x10];
const IDENTITY_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

function avc1Entry(width: number, height: number, avcC: number[] = AVCC, extraBoxes: Uint8Array[] = []): Uint8Array {
  return box(
    'avc1',
    new Array(6).fill(0), be16(1), new Array(16).fill(0), be16(width), be16(height),
    be32(0x480000), be32(0x480000), be32(0), be16(1), new Array(32).fill(0), be16(0x18), be16(0xffff),
    box('avcC', avcC),
    ...extraBoxes
  );
}

function descriptor(tag: number, ...payload: Array<number[] | Uint8Array>): Uint8Array {
  const body = cat(...payload);
  return cat([tag], [body.byteLength], body);
}

function esds(oti: number, asc: number[]): Uint8Array {
  const decoderSpecific = asc.length > 0 ? [descriptor(0x05, asc)] : [];
  const decoderConfig = descriptor(0x04, [oti, 0x15, 0, 0, 0], be32(0), be32(0), ...decoderSpecific);
  return fullBox('esds', 0, 0, descriptor(0x03, be16(1), [0], decoderConfig, descriptor(0x06, [2])));
}

function mp4aEntry(channels: number, sampleRate: number, esdsBox: Uint8Array): Uint8Array {
  return box(
    'mp4a',
    new Array(6).fill(0), be16(1), be16(0), be16(0), be32(0), be16(channels), be16(16), be16(0), be16(0),
    be32((sampleRate & 0xffff) << 16), esdsBox
  );
}

interface HandTrack {
  handler: 'vide' | 'soun';
  mediaTimescale: number;
  entry: Uint8Array;
  /** Sample sizes; sample j of track t holds the byte (t * 64 + j + 1). */
  sizes: number[];
  /** stts entries as [count, delta]; defaults to one entry of delta 1000. */
  stts?: Array<[number, number]>;
  samplesPerChunk?: number;
  /** Extra stbl children such as ctts or stss. */
  extra?: Uint8Array[];
  /** stbl children to leave out, by type. */
  omit?: string[];
  matrix?: number[];
  enabled?: boolean;
  edts?: Uint8Array;
  use64BitOffsets?: boolean;
  /** Added to every chunk offset, to point past the end of the file. */
  offsetShift?: number;
}

function handTrackBoxes(track: HandTrack, trackId: number, offsets: number[]): Uint8Array {
  const sampleCount = track.sizes.length;
  const perChunk = track.samplesPerChunk ?? 1;
  const chunkOffsets: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += perChunk) {
    chunkOffsets.push(offsets[sample] + (track.offsetShift ?? 0));
  }
  const stblChildren: Array<[string, Uint8Array]> = [
    ['stsd', fullBox('stsd', 0, 0, be32(1), track.entry)],
    ['stts', fullBox('stts', 0, 0, ...stblEntries(track.stts ?? [[sampleCount, 1000]]))],
    ['stsc', fullBox('stsc', 0, 0, ...stscRuns(sampleCount, perChunk))],
    ['stsz', fullBox('stsz', 0, 0, be32(0), be32(sampleCount), packU32(track.sizes))],
    [
      track.use64BitOffsets ? 'co64' : 'stco',
      fullBox(
        track.use64BitOffsets ? 'co64' : 'stco', 0, 0,
        be32(chunkOffsets.length),
        ...(track.use64BitOffsets ? chunkOffsets.map((offset) => be64(offset)) : [packU32(chunkOffsets)])
      ),
    ],
  ];
  const stbl = box(
    'stbl',
    ...stblChildren.filter(([type]) => !(track.omit ?? []).includes(type)).map(([, bytes]) => bytes),
    ...(track.extra ?? [])
  );
  const mediaHeader = track.handler === 'vide' ? fullBox('vmhd', 0, 1, new Array(8).fill(0)) : fullBox('smhd', 0, 0, [0, 0, 0, 0]);
  const dinf = box('dinf', fullBox('dref', 0, 0, be32(1), fullBox('url ', 0, 1)));
  const minf = box('minf', mediaHeader, dinf, stbl);
  const mdhd = fullBox('mdhd', 0, 0, be32(0), be32(0), be32(track.mediaTimescale), be32(sampleCount * 1000), be16(0x55c4), be16(0));
  const hdlr = fullBox('hdlr', 0, 0, be32(0), ascii(track.handler), new Array(12).fill(0), [0]);
  const matrix = (track.matrix ?? IDENTITY_MATRIX).flatMap((value) => be32(value >>> 0));
  const tkhd = fullBox(
    'tkhd', 0, track.enabled === false ? 0 : 3,
    be32(0), be32(0), be32(trackId), be32(0), be32(sampleCount * 1000),
    new Array(8).fill(0), be16(0), be16(0), be16(track.handler === 'soun' ? 0x100 : 0), be16(0),
    matrix, be32(320 << 16), be32(240 << 16)
  );
  return box('trak', tkhd, ...(track.edts ? [track.edts] : []), box('mdia', mdhd, hdlr, minf));
}

/** Whole chunks of `perChunk` samples, then one shorter chunk for the remainder (ISO/IEC 14496-12 8.7.4). */
function stscRuns(sampleCount: number, perChunk: number): Array<number[]> {
  const wholeChunks = Math.floor(sampleCount / perChunk);
  const remainder = sampleCount % perChunk;
  const runs: Array<[number, number]> = [[1, perChunk]];
  if (remainder > 0) runs.push([wholeChunks + 1, remainder]);
  return [be32(runs.length), ...runs.map(([first, count]) => [...be32(first), ...be32(count), ...be32(1)])];
}

function stblEntries(entries: Array<[number, number]>): Array<number[]> {
  return [be32(entries.length), ...entries.map(([count, delta]) => [...be32(count), ...be32(delta)])];
}

interface HandMp4Options {
  movieTimescale?: number;
  /** Boxes appended after moov, such as a moof. */
  trailing?: Uint8Array[];
  /** Replaces the whole moov payload after mvhd. */
  moovExtra?: Uint8Array[];
}

function handMp4(tracks: HandTrack[], options: HandMp4Options = {}): Uint8Array {
  const movieTimescale = options.movieTimescale ?? 1000;
  const ftyp = box('ftyp', ascii('isom'), be32(0x200), ascii('isom'), ascii('iso2'));
  const mdatStart = ftyp.byteLength + 8;
  const trackOffsets: number[][] = [];
  let cursor = mdatStart;
  const mdatBody = new Uint8Array(tracks.reduce((total, track) => total + track.sizes.reduce((sum, size) => sum + size, 0), 0));
  tracks.forEach((track, trackIndex) => {
    const offsets: number[] = [];
    track.sizes.forEach((size, sampleIndex) => {
      offsets.push(cursor);
      mdatBody.fill((trackIndex * 64 + sampleIndex + 1) & 0xff, cursor - mdatStart, cursor - mdatStart + size);
      cursor += size;
    });
    trackOffsets.push(offsets);
  });
  const mdat = box('mdat', mdatBody);
  const mvhd = fullBox(
    'mvhd', 0, 0,
    be32(0), be32(0), be32(movieTimescale), be32(10_000), be32(0x10000), be16(0x100), new Array(10).fill(0),
    IDENTITY_MATRIX.flatMap((v) => be32(v >>> 0)), new Array(24).fill(0), be32(tracks.length + 1)
  );
  const moov = box(
    'moov',
    mvhd,
    ...tracks.map((track, index) => handTrackBoxes(track, index + 1, trackOffsets[index])),
    ...(options.moovExtra ?? [])
  );
  return cat(ftyp, mdat, moov, ...(options.trailing ?? []));
}

/** The bytes sample `sampleIndex` of track `trackIndex` was written with. */
function sampleFill(trackIndex: number, sampleIndex: number): number {
  return (trackIndex * 64 + sampleIndex + 1) & 0xff;
}

const videoTrack = (overrides: Partial<HandTrack> = {}): HandTrack => ({
  handler: 'vide',
  mediaTimescale: 1000,
  entry: avc1Entry(320, 240),
  sizes: [10, 11, 12, 13, 14],
  stts: [[5, 40]],
  ...overrides,
});

const audioTrack = (overrides: Partial<HandTrack> = {}): HandTrack => ({
  handler: 'soun',
  mediaTimescale: 44100,
  entry: mp4aEntry(2, 44100, esds(0x40, ASC_LC_44100_STEREO)),
  sizes: [20, 21, 22],
  stts: [[3, 1024]],
  ...overrides,
});

function demux(bytes: Uint8Array): DemuxedTrackInfo {
  return demuxMp4(toArrayBuffer(bytes));
}

describe('demuxMp4 on hand-assembled files', () => {
  it('takes timing, sizes, codec string and decoder configuration from the sample tables', () => {
    const track = demux(handMp4([videoTrack(), audioTrack()]));

    expect(track.type).toBe('video');
    expect(track.codec).toBe('avc1.64001f');
    expect(track.width).toBe(320);
    expect(track.height).toBe(240);
    expect(track.timescale).toBe(1000);
    expect(track.description).toEqual(new Uint8Array(AVCC));
    expect(track.samples.map((s) => s.timestampMicros)).toEqual([0, 40000, 80000, 120000, 160000]);
    expect(track.samples.map((s) => s.durationMicros)).toEqual([40000, 40000, 40000, 40000, 40000]);
    expect(track.samples.map((s) => s.data.byteLength)).toEqual([10, 11, 12, 13, 14]);
    track.samples.forEach((sample, index) => expect([...new Set(sample.data)]).toEqual([sampleFill(0, index)]));

    const audio = track.audioTrack as DemuxedTrackInfo;
    expect(audio.codec).toBe('mp4a.40.2');
    expect(audio.sampleRate).toBe(44100);
    expect(audio.channels).toBe(2);
    expect(audio.description).toEqual(new Uint8Array(ASC_LC_44100_STEREO));
    expect(audio.samples.map((s) => s.timestampMicros)).toEqual([0, Math.round((1024 * MICROS) / 44100), Math.round((2048 * MICROS) / 44100)]);
    expect(audio.samples.map((s) => s.data.byteLength)).toEqual([20, 21, 22]);
    audio.samples.forEach((sample, index) => expect([...new Set(sample.data)]).toEqual([sampleFill(1, index)]));
  });

  it('marks every sample a sync sample without stss, and only the listed ones with stss', () => {
    const withoutStss = demux(handMp4([videoTrack()]));
    expect(withoutStss.samples.map((s) => s.isKeyFrame)).toEqual([true, true, true, true, true]);

    const stss = fullBox('stss', 0, 0, be32(2), be32(1), be32(4));
    const withStss = demux(handMp4([videoTrack({ extra: [stss] })]));
    expect(withStss.samples.map((s) => s.isKeyFrame)).toEqual([true, false, false, true, false]);
  });

  it('adds the composition offsets of ctts and subtracts the media time of the edit list', () => {
    // Decode order I P B B P with display times 0, 120, 40, 80, 160 ms after a 80 ms start delay
    const ctts = fullBox('ctts', 0, 0, be32(5), ...[80, 160, 40, 40, 80].map((offset) => [...be32(1), ...be32(offset)]));
    const elst = fullBox('elst', 0, 0, be32(1), be32(200), be32(80), be16(1), be16(0));
    const track = demux(handMp4([videoTrack({ extra: [ctts], edts: box('edts', elst) })]));

    expect(track.samples.map((s) => s.timestampMicros)).toEqual([0, 120000, 40000, 80000, 160000]);
  });

  it('reads negative composition offsets of ctts version 1', () => {
    const ctts = fullBox('ctts', 1, 0, be32(5), ...[0, 80, -40, -40, 0].map((offset) => [...be32(1), ...be32(offset >>> 0)]));
    const track = demux(handMp4([videoTrack({ extra: [ctts] })]));

    expect(track.samples.map((s) => s.timestampMicros)).toEqual([0, 120000, 40000, 80000, 160000]);
  });

  it('shifts the track by an initial empty edit, measured in movie time', () => {
    const elst = fullBox(
      'elst', 0, 0, be32(2),
      be32(500), be32(0xffffffff), be16(1), be16(0),
      be32(200), be32(0), be16(1), be16(0)
    );
    const track = demux(handMp4([videoTrack({ edts: box('edts', elst) })], { movieTimescale: 1000 }));

    expect(track.samples.map((s) => s.timestampMicros)).toEqual([500000, 540000, 580000, 620000, 660000]);
  });

  it('maps samples through chunks holding several samples and through 64-bit chunk offsets', () => {
    const track = demux(handMp4([videoTrack({ samplesPerChunk: 2, use64BitOffsets: true })]));

    expect(track.samples.map((s) => s.data.byteLength)).toEqual([10, 11, 12, 13, 14]);
    track.samples.forEach((sample, index) => expect([...new Set(sample.data)]).toEqual([sampleFill(0, index)]));
  });

  it('ignores tracks that are neither video nor audio and disabled tracks', () => {
    const text = videoTrack({ handler: 'vide', enabled: false, sizes: [3], stts: [[1, 1000]] });
    const track = demux(handMp4([videoTrack(), text]));

    expect(track.samples).toHaveLength(5);
  });
});

describe('demuxMp4 refuses what it cannot read truthfully', () => {
  const valid = (): Uint8Array => handMp4([videoTrack()]);

  function expectRefusal(bytes: Uint8Array, message: RegExp): void {
    expect(() => demux(bytes)).toThrow(EdgeUnsupportedError);
    expect(() => demux(bytes)).toThrow(message);
  }

  it('reads the valid control file', () => {
    expect(demux(valid()).samples).toHaveLength(5);
  });

  it('throws without a moov box', () => {
    const bytes = valid();
    const withoutMoov = cat(...listBoxes(bytes).filter((b) => b.type !== 'moov').map((b) => bytes.subarray(b.start, b.end)));
    expectRefusal(withoutMoov, /no moov box/);
  });

  it('throws for two enabled video tracks and for two enabled audio tracks, which the edge cannot choose between', () => {
    expectRefusal(handMp4([videoTrack(), videoTrack()]), /more than one video track/);
    expectRefusal(handMp4([audioTrack(), audioTrack()]), /more than one audio track/);
  });

  it('throws when moov holds no usable track', () => {
    expectRefusal(handMp4([], {}), /no video or audio track/);
  });

  it.each(['stsd', 'stts', 'stsc', 'stsz', 'stco'])('throws when the track has no %s', (type) => {
    expectRefusal(handMp4([videoTrack({ omit: [type] })]), new RegExp(type));
  });

  it('throws for a stsz that claims more samples than the table can hold', () => {
    const hostile = fullBox('stsz', 0, 0, be32(0), be32(0x7fffffff));
    expectRefusal(handMp4([videoTrack({ omit: ['stsz'], extra: [hostile] })]), /stsz/);
  });

  it(`throws past ${MP4_MAX_SAMPLES_PER_TRACK} samples even when every sample has one size`, () => {
    const uniform = fullBox('stsz', 0, 0, be32(1), be32(MP4_MAX_SAMPLES_PER_TRACK + 1));
    const started = Date.now();
    expectRefusal(handMp4([videoTrack({ omit: ['stsz'], extra: [uniform] })]), /sample limit/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('throws when stts and stsz count different numbers of samples', () => {
    expectRefusal(handMp4([videoTrack({ stts: [[4, 40]] })]), /stts/);
  });

  it('throws when a stts entry count runs past the box', () => {
    const lying = fullBox('stts', 0, 0, be32(1000), be32(5), be32(40));
    expectRefusal(handMp4([videoTrack({ omit: ['stts'], extra: [lying] })]), /stts/);
  });

  it('throws when a sample lies beyond the end of the file', () => {
    expectRefusal(handMp4([videoTrack({ offsetShift: 1 << 20 })]), /outside the file/);
  });

  it('throws when a box size runs past its parent', () => {
    const bytes = valid();
    const moov = listBoxes(bytes).find((b) => b.type === 'moov') as IsoBox;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(moov.start, moov.size + 1000);
    expectRefusal(bytes, /overruns/);
  });

  it('throws on a 64-bit box size beyond the file', () => {
    const hostile = cat(be32(1), ascii('moov'), be64(2 ** 40));
    expectRefusal(cat(box('ftyp', ascii('isom'), be32(0)), hostile), /overruns/);
  });

  it('throws on a truncated file', () => {
    const bytes = valid();
    expect(() => demux(bytes.subarray(0, bytes.byteLength - 40))).toThrow(EdgeUnsupportedError);
  });

  it('refuses VP8 in MP4, which no decoder configuration of the edge worker could take', () => {
    const entry = avc1Entry(320, 240);
    entry.set(ascii('vp08'), 4);
    expectRefusal(handMp4([videoTrack({ entry })]), /VP8 in MP4 \(vp08\) is not read/);
  });

  it('throws for a fragmented file, whose samples live in moof boxes', () => {
    const trun = fullBox('trun', 0, 0, be32(0));
    expectRefusal(handMp4([videoTrack()], { trailing: [box('moof', trun)] }), /fragmented/);
  });

  it('throws for more than one sample description', () => {
    const twoEntries = fullBox('stsd', 0, 0, be32(2), avc1Entry(320, 240), avc1Entry(320, 240));
    expectRefusal(handMp4([videoTrack({ omit: ['stsd'], extra: [twoEntries] })]), /sample description/);
  });

  it('throws for a sample entry it has no decoder configuration for', () => {
    const mp4v = box('mp4v', new Array(78).fill(0));
    expectRefusal(handMp4([videoTrack({ entry: mp4v })]), /mp4v/);
  });

  it('throws for an avc1 entry without avcC', () => {
    const bare = box('avc1', new Array(78).fill(0));
    expectRefusal(handMp4([videoTrack({ entry: bare })]), /avcC/);
  });

  it('throws for an edit list that cuts or loops the media', () => {
    const elst = fullBox(
      'elst', 0, 0, be32(2),
      be32(100), be32(0), be16(1), be16(0),
      be32(100), be32(500), be16(1), be16(0)
    );
    expectRefusal(handMp4([videoTrack({ edts: box('edts', elst) })]), /edit list/);
  });

  it('throws for an edit list whose media edit is shorter than the media, or has no length', () => {
    // 5 samples of 40 ms are 200 ms of media; the edit presents 100 ms of it
    const cut = fullBox('elst', 0, 0, be32(1), be32(100), be32(0), be16(1), be16(0));
    expectRefusal(handMp4([videoTrack({ edts: box('edts', cut) })]), /edit list presents 100 ms of a video track that has 200 ms/);
    const empty = fullBox('elst', 0, 0, be32(1), be32(0), be32(0), be16(1), be16(0));
    expectRefusal(handMp4([videoTrack({ edts: box('edts', empty) })]), /edit list presents 0 ms/);
  });

  it('reads an edit that is longer than the media, or shorter by less than one sample', () => {
    const longer = fullBox('elst', 0, 0, be32(1), be32(5000), be32(0), be16(1), be16(0));
    expect(demux(handMp4([videoTrack({ edts: box('edts', longer) })])).samples).toHaveLength(5);
    const nearly = fullBox('elst', 0, 0, be32(1), be32(170), be32(0), be16(1), be16(0));
    expect(demux(handMp4([videoTrack({ edts: box('edts', nearly) })])).samples).toHaveLength(5);
  });

  it('throws when the edit starts inside a video track and hides its leading frames', () => {
    // No composition offsets: the first two frames (dts 0 and 40 ms) would present before time zero
    const hiding = fullBox('elst', 0, 0, be32(1), be32(200), be32(80), be16(1), be16(0));
    expectRefusal(handMp4([videoTrack({ edts: box('edts', hiding) })]), /hides 2 leading video frames/);
  });

  it('throws for an edit list that changes the playback rate', () => {
    const elst = fullBox('elst', 0, 0, be32(1), be32(200), be32(0), be16(2), be16(0));
    expectRefusal(handMp4([videoTrack({ edts: box('edts', elst) })]), /edit list/);
  });

  it('throws for AAC that is not AAC-LC', () => {
    // audioObjectType 5 (SBR), 44.1 kHz, stereo
    const he = mp4aEntry(2, 44100, esds(0x40, [0x2a, 0x10]));
    expectRefusal(handMp4([audioTrack({ entry: he })]), /AAC/);
  });

  it('throws for an audio object type it has no WebCodecs string for in esds', () => {
    const mpeg2 = mp4aEntry(2, 44100, esds(0x67, ASC_LC_44100_STEREO));
    expectRefusal(handMp4([audioTrack({ entry: mpeg2 })]), /0x67/);
  });

  it('throws on a descriptor length that runs past the esds box', () => {
    const broken = fullBox('esds', 0, 0, [0x03, 0x7f, 0, 1, 0]);
    expectRefusal(handMp4([audioTrack({ entry: mp4aEntry(2, 44100, broken) })]), /esds/);
  });
});

/** ISO/IEC 14496-12 12.1.4 `colr` of colour type nclx: three ISO/IEC 23091-2 code points and the range bit. */
function colrNclx(primaries: number, transfer: number, matrix: number, fullRange: boolean): Uint8Array {
  return box('colr', ascii('nclx'), be16(primaries), be16(transfer), be16(matrix), [fullRange ? 0x80 : 0]);
}

describe('demuxMp4 and the picture metadata the edge has to honour', () => {
  const CODE_POINT_SMPTE170M = 6;
  const CODE_POINT_BT709 = 1;
  const CODE_POINT_UNSPECIFIED = 2;
  const withEntryBoxes = (...boxes: Uint8Array[]): Uint8Array =>
    handMp4([videoTrack({ entry: avc1Entry(320, 240, AVCC, boxes) })]);

  oracleTest('reports the colour description the reference tools read from colr', ['ffmpeg', 'ffprobe'], () => {
    const mp4 = h264AacMp4(['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv']);
    const stream = streamOf(ffprobeReport(new Uint8Array(mp4), 'mp4'), 'video');
    expect([stream.color_space, stream.color_primaries, stream.color_transfer, stream.color_range]).toEqual([
      'smpte170m', 'smpte170m', 'smpte170m', 'tv',
    ]);

    expect(demuxMp4(toArrayBuffer(mp4)).colour).toEqual({
      primaries: CODE_POINT_SMPTE170M,
      transfer: CODE_POINT_SMPTE170M,
      matrix: CODE_POINT_SMPTE170M,
      fullRange: false,
    });
  });

  oracleTest('reports full range from the nclx range bit', ['ffmpeg', 'ffprobe'], () => {
    const mp4 = h264AacMp4(['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'pc']);
    expect(streamOf(ffprobeReport(new Uint8Array(mp4), 'mp4'), 'video').color_range).toBe('pc');

    expect(demuxMp4(toArrayBuffer(mp4)).colour).toEqual({
      primaries: CODE_POINT_BT709,
      transfer: CODE_POINT_BT709,
      matrix: CODE_POINT_BT709,
      fullRange: true,
    });
  });

  oracleTest('states no colour for a file that carries none', ['ffmpeg', 'ffprobe'], () => {
    const mp4 = h264AacMp4();
    const stream = streamOf(ffprobeReport(new Uint8Array(mp4), 'mp4'), 'video');
    expect(stream.color_space ?? 'unknown').toBe('unknown');

    expect(demuxMp4(toArrayBuffer(mp4)).colour).toBeUndefined();
  });

  oracleTest('refuses a non-square pixel aspect ratio, which the output would present as square', ['ffmpeg', 'ffprobe'], () => {
    const mp4 = h264AacMp4(['-vf', 'setsar=4/3']);
    expect(streamOf(ffprobeReport(new Uint8Array(mp4), 'mp4'), 'video').sample_aspect_ratio).toBe('4:3');

    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(EdgeUnsupportedError);
    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(/pixel aspect ratio 4:3/);
  });

  oracleTest('refuses a track header that presents a different size than the coded pictures', ['ffmpeg', 'ffprobe'], () => {
    const mp4 = new Uint8Array(h264AacMp4());
    const tkhd = findPath(mp4, listBoxes(mp4), ['moov', 'trak', 'tkhd'])[0];
    // ISO/IEC 14496-12 8.3.2: in a version 0 tkhd the 16.16 width follows the matrix, 76 bytes into the payload.
    const TKHD_V0_WIDTH_OFFSET = 76;
    expect(new DataView(mp4.buffer, mp4.byteOffset).getUint32(tkhd.payloadStart + TKHD_V0_WIDTH_OFFSET)).toBe(320 * 0x10000);
    new DataView(mp4.buffer, mp4.byteOffset).setUint32(tkhd.payloadStart + TKHD_V0_WIDTH_OFFSET, 640 * 0x10000);

    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(EdgeUnsupportedError);
    expect(() => demuxMp4(toArrayBuffer(mp4))).toThrow(/track header presents 640x240 but the pictures are coded 320x240/);
  });

  it('refuses a track header whose size has a fractional part', () => {
    const bytes = handMp4([videoTrack()]);
    const tkhd = findPath(bytes, listBoxes(bytes), ['moov', 'trak', 'tkhd'])[0];
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(tkhd.payloadStart + 76, (320 * 0x10000) | 0x8000);

    expect(() => demux(bytes)).toThrow(/track header presents 320.5x240 but the pictures are coded 320x240/);
  });

  it('reads a 1:1 pasp as no aspect change', () => {
    expect(demux(withEntryBoxes(box('pasp', be32(1), be32(1)))).width).toBe(320);
    expect(demux(withEntryBoxes(box('pasp', be32(5), be32(5)))).width).toBe(320);
  });

  it('refuses pasp spacing that is not 1:1, and spacing of zero', () => {
    expect(() => demux(withEntryBoxes(box('pasp', be32(16), be32(11))))).toThrow(/pixel aspect ratio 16:11/);
    expect(() => demux(withEntryBoxes(box('pasp', be32(0), be32(1))))).toThrow(/pixel aspect ratio 0:1/);
  });

  it('refuses a clean aperture box, which crops the displayed picture', () => {
    // ISO/IEC 14496-12 12.1.4.1: cleanApertureWidth, Height, horizOff and vertOff, each a numerator and denominator
    const clap = box('clap', be32(300), be32(1), be32(220), be32(1), be32(0), be32(1), be32(0), be32(1));
    expect(() => demux(withEntryBoxes(clap))).toThrow(EdgeUnsupportedError);
    expect(() => demux(withEntryBoxes(clap))).toThrow(/clean aperture/);
  });

  it('refuses an ICC profile, which the edge cannot pass to the encoder or the output', () => {
    const icc = box('colr', ascii('prof'), new Array(16).fill(0));
    expect(() => demux(withEntryBoxes(icc))).toThrow(/ICC profile/);
    expect(() => demux(withEntryBoxes(box('colr', ascii('rICC'), [0])))).toThrow(/ICC profile/);
  });

  it('reads nclx values as stored, unspecified included, and the QuickTime nclc as limited range', () => {
    expect(demux(withEntryBoxes(colrNclx(9, 16, 9, true))).colour).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true });
    expect(demux(withEntryBoxes(colrNclx(CODE_POINT_UNSPECIFIED, CODE_POINT_UNSPECIFIED, CODE_POINT_UNSPECIFIED, false))).colour).toEqual({
      primaries: CODE_POINT_UNSPECIFIED, transfer: CODE_POINT_UNSPECIFIED, matrix: CODE_POINT_UNSPECIFIED, fullRange: false,
    });
    const nclc = box('colr', ascii('nclc'), be16(1), be16(1), be16(6));
    expect(demux(withEntryBoxes(nclc)).colour).toEqual({ primaries: 1, transfer: 1, matrix: 6, fullRange: false });
  });

  it('refuses a colr box that is cut short, and a colour type it does not know', () => {
    expect(() => demux(withEntryBoxes(box('colr', ascii('nclx'), be16(1), be16(1))))).toThrow(EdgeUnsupportedError);
    expect(() => demux(withEntryBoxes(box('colr', ascii('abcd'), [0, 0])))).toThrow(/colour type "abcd"/);
  });

  it('prefers an nclx description over an ICC profile that comes with it', () => {
    const track = demux(withEntryBoxes(box('colr', ascii('prof'), [0, 0, 0, 0]), colrNclx(1, 1, 1, false)));
    expect(track.colour).toEqual({ primaries: 1, transfer: 1, matrix: 1, fullRange: false });
  });
});

describe('demuxMp4 reports the bit depth and chroma layout the file states', () => {
  const FACTS_TIMEOUT_MS = 60_000;
  const clip = (codecArgs: string[], pixFmt: string, extension = 'mp4'): Buffer =>
    runFfmpeg([...testPatternInput({ width: 128, height: 96, fps: 25, seconds: 0.2 }), ...codecArgs, '-pix_fmt', pixFmt, '-f', 'mp4'], extension);

  // pix_fmt as ffprobe names it, and the facts it means (ffmpeg pixel format descriptions: planes and bit depth)
  const PIXEL_FORMATS: Record<string, { bitDepth: number; chroma: string }> = {
    yuv420p: { bitDepth: 8, chroma: 'yuv420' },
    yuv422p: { bitDepth: 8, chroma: 'yuv422' },
    yuv444p: { bitDepth: 8, chroma: 'yuv444' },
    yuv420p10le: { bitDepth: 10, chroma: 'yuv420' },
    yuv422p10le: { bitDepth: 10, chroma: 'yuv422' },
    yuv420p12le: { bitDepth: 12, chroma: 'yuv420' },
    gray: { bitDepth: 8, chroma: 'mono' },
  };

  const CASES: Array<{ codec: string; encoder: string; args: string[]; pixFmt: string }> = [
    { codec: 'H.264', encoder: 'libx264', args: ['-c:v', 'libx264'], pixFmt: 'yuv420p' },
    { codec: 'H.264', encoder: 'libx264', args: ['-c:v', 'libx264'], pixFmt: 'yuv420p10le' },
    { codec: 'H.264', encoder: 'libx264', args: ['-c:v', 'libx264'], pixFmt: 'yuv422p' },
    { codec: 'H.264', encoder: 'libx264', args: ['-c:v', 'libx264'], pixFmt: 'yuv444p' },
    { codec: 'HEVC', encoder: 'libx265', args: ['-c:v', 'libx265', '-x265-params', 'log-level=none'], pixFmt: 'yuv420p' },
    { codec: 'HEVC', encoder: 'libx265', args: ['-c:v', 'libx265', '-x265-params', 'log-level=none'], pixFmt: 'yuv422p10le' },
    { codec: 'HEVC', encoder: 'libx265', args: ['-c:v', 'libx265', '-x265-params', 'log-level=none'], pixFmt: 'yuv444p' },
    { codec: 'VP9', encoder: 'libvpx-vp9', args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime'], pixFmt: 'yuv420p' },
    { codec: 'VP9', encoder: 'libvpx-vp9', args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime'], pixFmt: 'yuv422p' },
    { codec: 'VP9', encoder: 'libvpx-vp9', args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime'], pixFmt: 'yuv444p' },
    { codec: 'VP9', encoder: 'libvpx-vp9', args: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime'], pixFmt: 'yuv420p10le' },
    { codec: 'AV1', encoder: 'libaom-av1', args: ['-c:v', 'libaom-av1', '-cpu-used', '8'], pixFmt: 'yuv420p' },
    { codec: 'AV1', encoder: 'libaom-av1', args: ['-c:v', 'libaom-av1', '-cpu-used', '8'], pixFmt: 'yuv444p' },
    { codec: 'AV1', encoder: 'libaom-av1', args: ['-c:v', 'libaom-av1', '-cpu-used', '8'], pixFmt: 'yuv420p12le' },
    { codec: 'AV1', encoder: 'libaom-av1', args: ['-c:v', 'libaom-av1', '-cpu-used', '8'], pixFmt: 'gray' },
  ];

  for (const { codec, encoder, args, pixFmt } of CASES) {
    oracleTest(`${codec} ${pixFmt}: the facts of the reference's own pixel format`, ['ffmpeg', 'ffprobe'], () => {
      requireEncoders(encoder);
      const mp4 = clip(args, pixFmt);
      expect(streamOf(ffprobeReport(new Uint8Array(mp4), 'mp4'), 'video').pix_fmt).toBe(pixFmt);

      const track = demuxMp4(toArrayBuffer(mp4));

      expect({ bitDepth: track.bitDepth, chroma: track.chroma }).toEqual(PIXEL_FORMATS[pixFmt]);
    }, FACTS_TIMEOUT_MS);
  }

  oracleTest('H.264 baseline and main profiles are 8-bit 4:2:0 by definition, with no extension in avcC', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libx264');
    for (const profile of ['baseline', 'main']) {
      const mp4 = runFfmpeg(
        [...testPatternInput({ width: 128, height: 96, fps: 25, seconds: 0.2 }), '-c:v', 'libx264', '-profile:v', profile, '-pix_fmt', 'yuv420p'],
        'mp4'
      );
      const track = demuxMp4(toArrayBuffer(mp4));
      expect({ bitDepth: track.bitDepth, chroma: track.chroma }).toEqual({ bitDepth: 8, chroma: 'yuv420' });
    }
  });

  const avcWithProfile = (profile: number, tail: number[] = []): number[] => [
    1, profile, 0x00, 0x1f, 0xff, 0xe1, ...be16(SPS.length), ...SPS, 1, ...be16(PPS.length), ...PPS, ...tail,
  ];
  const demuxAvc = (avcC: number[]): DemuxedTrackInfo => demux(handMp4([videoTrack({ entry: avc1Entry(320, 240, avcC) })]));

  it('states nothing for a high profile whose avcC carries no extension, instead of assuming 8-bit 4:2:0', () => {
    const track = demuxAvc(avcWithProfile(0x64));
    expect(track.bitDepth).toBeUndefined();
    expect(track.chroma).toBeUndefined();
  });

  it('reads the extension of a high profile avcC: chroma_format, then luma and chroma bit depth', () => {
    // ISO/IEC 14496-15 5.3.3.1.2: 6 reserved bits + chroma_format, 5 reserved + bit_depth_luma_minus8, same for chroma
    const track = demuxAvc(avcWithProfile(0x6e, [0xfe, 0xfa, 0xfa, 0]));
    expect({ bitDepth: track.bitDepth, chroma: track.chroma }).toEqual({ bitDepth: 10, chroma: 'yuv422' });
  });

  it('states no bit depth when luma and chroma differ, which no single field can say', () => {
    const track = demuxAvc(avcWithProfile(0x6e, [0xfd, 0xfa, 0xf8, 0]));
    expect(track.bitDepth).toBeUndefined();
    expect(track.chroma).toBe('yuv420');
  });

  it('refuses an avcC extension that is cut short, and an SPS count that runs past the record', () => {
    expect(() => demuxAvc(avcWithProfile(0x64, [0xfd, 0xf8]))).toThrow(EdgeUnsupportedError);
    expect(() => demuxAvc(avcWithProfile(0x64, [0xfd, 0xf8]))).toThrow(/avcC is truncated/);
    const lying = avcWithProfile(0x64);
    lying[5] = 0xff; // 31 sequence parameter sets
    expect(() => demuxAvc(lying)).toThrow(/avcC is truncated/);
  });
});

describe('demuxMp4 on files built to exhaust it', () => {
  function expectRefusal(bytes: Uint8Array, message: RegExp): void {
    expect(() => demux(bytes)).toThrow(EdgeUnsupportedError);
    expect(() => demux(bytes)).toThrow(message);
  }

  it('refuses the second enabled track of a kind before reading its sample tables', () => {
    // Every track after the first claims the largest stsz there is. Reading one would raise a different error and
    // allocate; the refusal must come from the count of tracks, so the tables were never walked.
    const lying = fullBox('stsz', 0, 0, be32(1), be32(MP4_MAX_SAMPLES_PER_TRACK));
    const tracks = [videoTrack(), ...Array.from({ length: 15 }, () => videoTrack({ omit: ['stsz'], extra: [lying] }))];
    const bytes = handMp4(tracks);
    const heapBefore = process.memoryUsage().arrayBuffers;
    const started = Date.now();

    expectRefusal(bytes, /more than one video track/);

    expect(Date.now() - started).toBeLessThan(500);
    expect(process.memoryUsage().arrayBuffers - heapBefore).toBeLessThan(8 * 1024 * 1024);
  });

  it('refuses a uniform stsz that claims more sample bytes than the file holds, before allocating the tables', () => {
    const lying = fullBox('stsz', 0, 0, be32(1000), be32(MP4_MAX_SAMPLES_PER_TRACK));
    const heapBefore = process.memoryUsage().arrayBuffers;

    expectRefusal(handMp4([videoTrack({ omit: ['stsz'], extra: [lying] })]), /more than the file holds/);

    expect(process.memoryUsage().arrayBuffers - heapBefore).toBeLessThan(8 * 1024 * 1024);
  });

  it('refuses a file whose tracks together claim more samples than the whole-file budget', () => {
    const perTrack = (MP4_MAX_TOTAL_SAMPLES * 0.6) | 0;
    expect(perTrack).toBeLessThanOrEqual(MP4_MAX_SAMPLES_PER_TRACK);
    const big = (build: typeof videoTrack | typeof audioTrack) =>
      build({ sizes: new Array(perTrack).fill(1), stts: [[perTrack, 1]], samplesPerChunk: perTrack });

    expectRefusal(handMp4([big(videoTrack), big(audioTrack)]), /budget of the file/);
  });
});

describe('demuxMedia routes by container and refuses the rest', () => {
  it.each(['avi', 'mkv', 'webm', 'flv', 'ogv', 'aac', ''])('has no demuxer for %s', (format) => {
    expect(() => demuxMedia(new ArrayBuffer(64), format)).toThrow(EdgeUnsupportedError);
    expect(() => demuxMedia(new ArrayBuffer(64), format)).toThrow(/no demuxer/);
  });

  it('does not read an MP4 declared as WAV, or a WAV declared as MP4', () => {
    const mp4 = toArrayBuffer(handMp4([videoTrack()]));
    expect(() => demuxMedia(mp4, 'wav')).toThrow(EdgeUnsupportedError);
    expect(() => demuxMedia(toArrayBuffer(wavBytes({ data: [1, 2, 3, 4] })), 'mp4')).toThrow(EdgeUnsupportedError);
  });

  it.each(['mp4', 'm4v', 'mov', 'm4a'])('reads ISO BMFF declared as %s', (format) => {
    expect(demuxMedia(toArrayBuffer(handMp4([videoTrack()])), format).samples).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------------------------------

function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function riffChunk(id: string, payload: number[]): number[] {
  return [...ascii(id), ...le32(payload.length), ...payload, ...(payload.length % 2 === 1 ? [0] : [])];
}

interface WavSpec {
  tag?: number;
  channels?: number;
  rate?: number;
  bits?: number;
  /** Chunks placed between WAVE and fmt, between fmt and data, and after data. */
  before?: number[];
  between?: number[];
  after?: number[];
  data: number[];
  /** Declared size of the data chunk when it differs from the bytes. */
  declaredDataSize?: number;
  fmtOverride?: number[];
  magic?: string;
  omitFmt?: boolean;
  dataFirst?: boolean;
}

function wavBytes(spec: WavSpec): Uint8Array {
  const channels = spec.channels ?? 2;
  const rate = spec.rate ?? 8000;
  const bits = spec.bits ?? 16;
  const blockAlign = (channels * bits) / 8;
  const fmtBody =
    spec.fmtOverride ?? [...le16(spec.tag ?? 1), ...le16(channels), ...le32(rate), ...le32(rate * blockAlign), ...le16(blockAlign), ...le16(bits)];
  const dataChunk =
    spec.declaredDataSize === undefined
      ? riffChunk('data', spec.data)
      : [...ascii('data'), ...le32(spec.declaredDataSize), ...spec.data];
  const fmtChunk = spec.omitFmt ? [] : riffChunk('fmt ', fmtBody);
  const body = [
    ...ascii('WAVE'),
    ...(spec.before ?? []),
    ...(spec.dataFirst ? [...dataChunk, ...fmtChunk] : [...fmtChunk, ...(spec.between ?? []), ...dataChunk]),
    ...(spec.after ?? []),
  ];
  return Uint8Array.from([...ascii(spec.magic ?? 'RIFF'), ...le32(body.length), ...body]);
}

function wavFixture(codec: string, rate: number, channels: number, rawFormat: string): { bytes: Buffer; raw: Buffer } {
  const args = [...sineInput(rate, 1), '-ac', String(channels), '-c:a', codec];
  const bytes = runFfmpeg([...args, '-f', 'wav'], 'wav');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wav-oracle-'));
  try {
    const file = path.join(dir, 'in.wav');
    writeFileSync(file, bytes);
    const ffmpeg = getOracleToolPath('ffmpeg') as string;
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', rawFormat, '-'], { maxBuffer: 64 * 1024 * 1024 });
    return { bytes, raw };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WAV_CASES: Array<{ codec: string; rate: number; channels: number; raw: string; label: string; bytesPerSample: number }> = [
  { codec: 'pcm_s16le', rate: 44100, channels: 2, raw: 's16le', label: 'pcm-s16', bytesPerSample: 2 },
  { codec: 'pcm_s16le', rate: 16000, channels: 1, raw: 's16le', label: 'pcm-s16', bytesPerSample: 2 },
  { codec: 'pcm_s24le', rate: 48000, channels: 2, raw: 's24le', label: 'pcm-s24', bytesPerSample: 3 },
  { codec: 'pcm_s32le', rate: 48000, channels: 2, raw: 's32le', label: 'pcm-s32', bytesPerSample: 4 },
  { codec: 'pcm_f32le', rate: 48000, channels: 2, raw: 'f32le', label: 'pcm-f32', bytesPerSample: 4 },
];

describe('demuxWav against ffmpeg', () => {
  for (const c of WAV_CASES) {
    oracleTest(`reads ${c.codec} at ${c.rate} Hz, ${c.channels} ch: stream facts and every PCM byte`, ['ffmpeg', 'ffprobe'], () => {
      const { bytes, raw } = wavFixture(c.codec, c.rate, c.channels, c.raw);
      const stream = streamOf(ffprobeReport(bytes, 'wav'), 'audio');
      // The reference tool writes a LIST chunk before data, which a fixed 44-byte header would misread as audio
      expect(Buffer.from(bytes).indexOf('LIST')).toBeGreaterThan(-1);
      expect(stream.codec_name).toBe(c.codec);

      const track = demuxWav(toArrayBuffer(bytes));

      expect(track.type).toBe('audio');
      expect(track.codec).toBe(c.label);
      expect(track.sampleRate).toBe(c.rate);
      expect(track.channels).toBe(c.channels);
      expect(Buffer.concat(track.samples.map((s) => Buffer.from(s.data)))).toEqual(raw);

      const frameBytes = c.channels * c.bytesPerSample;
      let frames = 0;
      for (const sample of track.samples) {
        expect(sample.timestampMicros).toBe(Math.round((frames * MICROS) / c.rate));
        expect(sample.data.byteLength % frameBytes).toBe(0);
        frames += sample.data.byteLength / frameBytes;
        expect(sample.durationMicros).toBe(Math.round(((sample.data.byteLength / frameBytes) * MICROS) / c.rate));
        expect(sample.isKeyFrame).toBe(true);
      }
      expect(frames).toBe(raw.byteLength / frameBytes);
    });
  }
});

describe('demuxWav on hand-assembled files', () => {
  const PCM = [1, 2, 3, 4, 5, 6, 7, 8]; // two 16-bit stereo frames

  function pcmOf(bytes: Uint8Array): number[] {
    return demuxWav(toArrayBuffer(bytes)).samples.flatMap((s) => [...s.data]);
  }

  it('skips LIST, fact and odd-sized unknown chunks and honours their pad bytes', () => {
    const before = riffChunk('LIST', [...ascii('INFOISFT'), ...le32(5), ...ascii('hello'), 0]);
    const between = [...riffChunk('fact', le32(2)), ...riffChunk('JUNK', [9, 9, 9])];
    const after = riffChunk('id3 ', [7, 7, 7]);

    expect(pcmOf(wavBytes({ data: PCM, before, between, after }))).toEqual(PCM);
  });

  it('reads a data chunk with an odd size and drops the incomplete last frame', () => {
    expect(pcmOf(wavBytes({ data: [...PCM, 99], channels: 2 }))).toEqual(PCM);
  });

  it('reads a WAVE_FORMAT_EXTENSIBLE header whose subformat is PCM', () => {
    const subFormatPcm = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    const fmt = [
      ...le16(0xfffe), ...le16(2), ...le32(8000), ...le32(8000 * 6), ...le16(6), ...le16(24),
      ...le16(22), ...le16(24), ...le32(3), ...subFormatPcm,
    ];
    const bytes = wavBytes({ data: [1, 2, 3, 4, 5, 6], fmtOverride: fmt, channels: 1, bits: 24 });
    const track = demuxWav(toArrayBuffer(bytes));

    expect(track.codec).toBe('pcm-s24');
    expect(track.channels).toBe(2);
    expect(track.samples.flatMap((s) => [...s.data])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reads a streamed data chunk whose size is 0xFFFFFFFF as running to the end of the file', () => {
    expect(pcmOf(wavBytes({ data: PCM, declaredDataSize: 0xffffffff }))).toEqual(PCM);
  });

  it.each([
    ['8-bit PCM', { bits: 8, data: [1, 2] }, /8-bit/],
    ['IMA ADPCM', { tag: 0x11, data: PCM }, /format tag 0x11/],
    ['A-law', { tag: 6, bits: 8, data: PCM }, /format tag 0x6/],
    ['MPEG layer 3 in WAV', { tag: 0x55, data: PCM }, /format tag 0x55/],
    ['64-bit float', { tag: 3, bits: 64, data: PCM }, /64-bit/],
    ['a zero channel count', { channels: 0, data: PCM, fmtOverride: [...le16(1), ...le16(0), ...le32(8000), ...le32(0), ...le16(0), ...le16(16)] }, /channel/],
    ['a zero sample rate', { rate: 0, data: PCM }, /sample rate/],
    ['a block align that disagrees with the format', { data: PCM, fmtOverride: [...le16(1), ...le16(2), ...le32(8000), ...le32(32000), ...le16(3), ...le16(16)] }, /block align/],
    ['an fmt chunk that is too short', { data: PCM, fmtOverride: [...le16(1), ...le16(2)] }, /fmt/],
    ['a missing fmt chunk', { data: PCM, omitFmt: true }, /fmt/],
    ['data before fmt', { data: PCM, dataFirst: true }, /fmt/],
    ['a data chunk longer than the file', { data: PCM, declaredDataSize: 4000 }, /data chunk/],
    ['an empty data chunk', { data: [] }, /no audio frames/],
    ['RF64', { data: PCM, magic: 'RF64' }, /RIFF/],
    ['big-endian RIFX', { data: PCM, magic: 'RIFX' }, /RIFF/],
  ] as Array<[string, WavSpec, RegExp]>)('throws for %s', (_name, spec, message) => {
    expect(() => demuxWav(toArrayBuffer(wavBytes(spec)))).toThrow(EdgeUnsupportedError);
    expect(() => demuxWav(toArrayBuffer(wavBytes(spec)))).toThrow(message);
  });

  it('throws for a file cut inside a chunk header', () => {
    const bytes = wavBytes({ data: PCM });
    expect(() => demuxWav(toArrayBuffer(bytes.subarray(0, 14)))).toThrow(EdgeUnsupportedError);
    expect(() => demuxWav(toArrayBuffer(bytes.subarray(0, 14)))).toThrow(/truncated/);
  });

  it('throws for thousands of leading chunks instead of walking them all', () => {
    const junk = Array.from({ length: 5000 }, () => riffChunk('JUNK', [])).flat();
    expect(() => demuxWav(toArrayBuffer(wavBytes({ data: PCM, before: junk })))).toThrow(/chunk limit/);
  });

  it('throws on input that is not RIFF at all', () => {
    expect(() => demuxWav(new ArrayBuffer(512))).toThrow(EdgeUnsupportedError);
  });
});
