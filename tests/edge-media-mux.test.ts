import { describe, expect, it } from 'vitest';
import { buildAdtsHeader, muxAdtsStream, parseAacLcConfig } from '../src/lib/edge/media/aac';
import { demuxMp4 } from '../src/lib/edge/media/iso-bmff-demux';
import type { DemuxedMediaSample, EncodedMediaChunk, EncoderOutputConfig } from '../src/lib/edge/media/media-types';
import { muxMp4 } from '../src/lib/edge/media/mp4-mux';
import { muxOggOpus, opusPacketSamples } from '../src/lib/edge/media/ogg-opus-mux';
import { muxWebm } from '../src/lib/edge/media/webm-mux';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { walkWebm, WEBM_IDS, type WalkedWebm } from './helpers/ebml-walker';
import {
  ffmpegDecodedAudioBytes,
  ffmpegDecodeErrors,
  ffmpegVideoFrameHashes,
  requireEncoders,
  runFfmpeg,
  sineInput,
  testPatternInput,
} from './helpers/ffmpeg-media-fixtures';
import { ffprobeReport, type FfprobePacket, type FfprobeReport, type FfprobeStream } from './helpers/ffprobe-json';
import {
  listBoxes,
  payloadOf,
  readEsds,
  readFtyp,
  walkTracks,
  type IsoBox,
} from './helpers/iso-bmff-walker';
import { walkOggPages } from './helpers/ogg-walker';
import { oracleTest } from './helpers/oracle-test';

const MICROS = 1_000_000;
const TOLERANCE_SECONDS = 2e-6;
const SOURCE_VIDEO = { width: 320, height: 240, fps: 25, seconds: 2 };

/** Packs `[value, width]` fields most significant bit first, padding the last byte with zeros. */
function packBits(fields: Array<[number, number]>): Uint8Array {
  const bits = fields.flatMap(([value, width]) => Array.from({ length: width }, (_, i) => Math.floor(value / 2 ** (width - 1 - i)) % 2));
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    out[index >> 3] |= bit << (7 - (index & 7));
  });
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function chunksOf(samples: DemuxedMediaSample[], shiftMicros = 0): EncodedMediaChunk[] {
  return samples.map((sample) => ({
    data: sample.data,
    timestampMicros: sample.timestampMicros + shiftMicros,
    durationMicros: sample.durationMicros,
    isKeyFrame: sample.isKeyFrame,
  }));
}

function streamOf(report: FfprobeReport, type: 'video' | 'audio'): FfprobeStream {
  const stream = report.streams.find((candidate) => candidate.codec_type === type);
  if (!stream) throw new Error(`reference probe found no ${type} stream`);
  return stream;
}

function packetsOf(report: FfprobeReport, stream: FfprobeStream): FfprobePacket[] {
  return report.packets.filter((packet) => packet.stream_index === stream.index);
}

/** Every packet of `out` equals the packet of `source` in size, bytes, key flag and time (plus `shiftSeconds`). */
function expectSamePackets(out: FfprobePacket[], source: FfprobePacket[], shiftSeconds = 0): void {
  expect(out).toHaveLength(source.length);
  source.forEach((packet, index) => {
    expect(out[index].size).toBe(packet.size);
    expect(out[index].data_hash).toBe(packet.data_hash);
    expect(out[index].flags.startsWith('K')).toBe(packet.flags.startsWith('K'));
    expect(Math.abs(Number(out[index].pts_time) - (Number(packet.pts_time) + shiftSeconds))).toBeLessThanOrEqual(TOLERANCE_SECONDS);
  });
}

// ---------------------------------------------------------------------------------------------------
// Reference-authored sources whose chunks stand in for what an encoder produced
// ---------------------------------------------------------------------------------------------------

function h264Mp4(): Buffer {
  requireEncoders('libx264');
  return runFfmpeg(
    [...testPatternInput(SOURCE_VIDEO), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '12'],
    'mp4'
  );
}

function aacM4a(): Buffer {
  requireEncoders('aac');
  return runFfmpeg([...sineInput(44100, 2), '-c:a', 'aac', '-f', 'ipod'], 'm4a');
}

function h264AacMp4NoBFrames(): Buffer {
  requireEncoders('libx264', 'aac');
  return runFfmpeg(
    [
      ...testPatternInput(SOURCE_VIDEO),
      ...sineInput(44100, 2),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '12',
      '-c:a', 'aac', '-shortest',
    ],
    'mp4'
  );
}

/** A video track read from a reference file: chunks, the decoder configuration and the frame size. */
function videoSource(mp4: Buffer): { chunks: EncodedMediaChunk[]; config: EncoderOutputConfig; width: number; height: number } {
  const track = demuxMp4(toArrayBuffer(mp4));
  return {
    chunks: chunksOf(track.samples),
    config: { codec: track.codec, description: track.description },
    width: track.width as number,
    height: track.height as number,
  };
}

/** An audio track whose first (priming) timestamp is moved to zero, as an encoder's output starts at zero. */
function audioSource(mp4: Buffer, delayMicros = 0): { chunks: EncodedMediaChunk[]; config: EncoderOutputConfig; sampleRate: number; channels: number; shiftSeconds: number } {
  const demuxed = demuxMp4(toArrayBuffer(mp4));
  const track = demuxed.audioTrack ?? demuxed;
  const first = track.samples[0].timestampMicros;
  return {
    chunks: chunksOf(track.samples, -first + delayMicros),
    config: { codec: track.codec, description: track.description },
    sampleRate: track.sampleRate as number,
    channels: track.channels as number,
    shiftSeconds: (-first + delayMicros) / MICROS,
  };
}

// ---------------------------------------------------------------------------------------------------
// Independent readers of what the muxer wrote
// ---------------------------------------------------------------------------------------------------

function topLevelTypes(bytes: Uint8Array): string[] {
  return listBoxes(bytes).map((box) => box.type);
}

function trackBoxes(bytes: Uint8Array): IsoBox[] {
  const moov = listBoxes(bytes).find((box) => box.type === 'moov') as IsoBox;
  return listBoxes(bytes, moov.payloadStart, moov.end).filter((box) => box.type === 'trak');
}

function child(bytes: Uint8Array, parent: IsoBox, type: string): IsoBox {
  const found = listBoxes(bytes, parent.payloadStart, parent.end).find((box) => box.type === type);
  if (!found) throw new Error(`no ${type} box in ${parent.type}`);
  return found;
}

/** tkhd matrix and size of a version 0 tkhd (ISO/IEC 14496-12 8.3.2). */
function readTkhd(bytes: Uint8Array, trak: IsoBox): { matrix: number[]; width: number; height: number; trackId: number } {
  const tkhd = child(bytes, trak, 'tkhd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = tkhd.payloadStart;
  return {
    trackId: view.getUint32(base + 12),
    matrix: Array.from({ length: 9 }, (_, i) => view.getInt32(base + 40 + i * 4)),
    width: view.getUint32(base + 76) / 0x10000,
    height: view.getUint32(base + 80) / 0x10000,
  };
}

function readMdhdTimescale(bytes: Uint8Array, trak: IsoBox): number {
  const mdia = child(bytes, trak, 'mdia');
  const mdhd = child(bytes, mdia, 'mdhd');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(mdhd.payloadStart + 12);
}

/** Entries of a track's elst: [segment_duration, media_time] pairs, or none when the track has no edit list. */
function readElst(bytes: Uint8Array, trak: IsoBox): Array<[number, number]> {
  const edts = listBoxes(bytes, trak.payloadStart, trak.end).find((box) => box.type === 'edts');
  if (!edts) return [];
  const elst = child(bytes, edts, 'elst');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(elst.payloadStart + 4);
  return Array.from({ length: count }, (_, i) => [
    view.getUint32(elst.payloadStart + 8 + i * 12),
    view.getInt32(elst.payloadStart + 8 + i * 12 + 4),
  ]);
}

// ---------------------------------------------------------------------------------------------------
// MP4
// ---------------------------------------------------------------------------------------------------

describe('muxMp4 writes what the encoder reported', () => {
  oracleTest('H.264: avc1 with the encoder\'s avcC, readable and decodable by the reference tools', ['ffmpeg', 'ffprobe'], () => {
    const source = h264Mp4();
    const sourceReport = ffprobeReport(new Uint8Array(source), 'mp4');
    const video = videoSource(source);

    const out = muxMp4({ video, majorBrand: 'isom' });

    // Structure, read by an independent walker
    expect(topLevelTypes(out)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(readFtyp(out)).toEqual({ majorBrand: 'isom', compatibleBrands: ['isom', 'iso2', 'avc1', 'mp41'] });
    const tracks = walkTracks(out);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].handler).toBe('vide');
    expect(tracks[0].entries.map((entry) => entry.type)).toEqual(['avc1']);
    const avcC = tracks[0].entries[0].children.find((box) => box.type === 'avcC') as IsoBox;
    expect(payloadOf(out, avcC)).toEqual(video.config.description);
    expect(tracks[0].sampleCount).toBe(video.chunks.length);
    const tkhd = readTkhd(out, trackBoxes(out)[0]);
    expect(tkhd).toEqual({
      trackId: 1,
      matrix: [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000],
      width: SOURCE_VIDEO.width,
      height: SOURCE_VIDEO.height,
    });
    expect(readMdhdTimescale(out, trackBoxes(out)[0])).toBe(1_000_000);

    // Content, judged by the reference reader and decoder
    const outReport = ffprobeReport(out, 'mp4');
    const outVideo = streamOf(outReport, 'video');
    expect(outVideo).toMatchObject({
      codec_name: 'h264',
      profile: streamOf(sourceReport, 'video').profile,
      level: streamOf(sourceReport, 'video').level,
      width: SOURCE_VIDEO.width,
      height: SOURCE_VIDEO.height,
    });
    expectSamePackets(packetsOf(outReport, outVideo), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expect(ffmpegDecodeErrors(out, 'mp4')).toBe('');
    expect(ffmpegVideoFrameHashes(out, 'mp4')).toEqual(ffmpegVideoFrameHashes(new Uint8Array(source), 'mp4'));
  });

  oracleTest('VP9: vp09 with a vpcC that matches the source file\'s own', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libvpx-vp9');
    const source = runFfmpeg(
      [
        ...testPatternInput(SOURCE_VIDEO),
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-deadline', 'realtime', '-auto-alt-ref', '0',
        '-f', 'mp4',
      ],
      'mp4'
    );
    const sourceReport = ffprobeReport(new Uint8Array(source), 'mp4');
    const sourceEntry = walkTracks(new Uint8Array(source))[0].entries[0];
    const sourceVpcC = payloadOf(new Uint8Array(source), sourceEntry.children.find((box) => box.type === 'vpcC') as IsoBox);
    const video = videoSource(source);

    const out = muxMp4({ video, majorBrand: 'isom' });

    const entry = walkTracks(out)[0].entries[0];
    expect(entry.type).toBe('vp09');
    const vpcC = payloadOf(out, entry.children.find((box) => box.type === 'vpcC') as IsoBox);
    expect(vpcC).toEqual(sourceVpcC);
    expect(readFtyp(out).compatibleBrands).toEqual(['isom', 'iso2', 'mp41']);

    const outReport = ffprobeReport(out, 'mp4');
    const outVideo = streamOf(outReport, 'video');
    expect(outVideo.codec_name).toBe('vp9');
    expectSamePackets(packetsOf(outReport, outVideo), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expect(ffmpegDecodeErrors(out, 'mp4')).toBe('');
    expect(ffmpegVideoFrameHashes(out, 'mp4')).toEqual(ffmpegVideoFrameHashes(new Uint8Array(source), 'mp4'));
  });

  it('writes the vpcC of a short VP9 codec string with the defaults the binding names', () => {
    const chunks: EncodedMediaChunk[] = [
      { data: Uint8Array.from([1, 2, 3]), timestampMicros: 0, durationMicros: 40000, isKeyFrame: true },
      { data: Uint8Array.from([4, 5]), timestampMicros: 40000, durationMicros: 40000, isKeyFrame: false },
    ];

    const out = muxMp4({ video: { chunks, config: { codec: 'vp09.00.10.08' }, width: 64, height: 48 }, majorBrand: 'isom' });

    const entry = walkTracks(out)[0].entries[0];
    const vpcC = payloadOf(out, entry.children.find((box) => box.type === 'vpcC') as IsoBox);
    // version 1 and zero flags, profile 0, level 10, 8 bit | 4:2:0 co-located | limited range, BT.709 x3, no init data
    expect([...vpcC]).toEqual([1, 0, 0, 0, 0, 10, 0x82, 1, 1, 1, 0, 0]);
  });

  oracleTest('H.264: the source colour description becomes an nclx colr that the reference reads back', ['ffmpeg', 'ffprobe'], () => {
    const source = h264Mp4();
    expect(streamOf(ffprobeReport(new Uint8Array(source), 'mp4'), 'video').color_space ?? 'unknown').toBe('unknown');
    const video = { ...videoSource(source), colour: { primaries: 5, transfer: 6, matrix: 5, fullRange: true } };

    const out = muxMp4({ video, majorBrand: 'isom' });

    const entry = walkTracks(out)[0].entries[0];
    expect(entry.children.map((box) => box.type)).toEqual(['avcC', 'colr']);
    // 'nclx', primaries 5, transfer 6, matrix 5 as 16 bits, range flag in the top bit
    expect(Array.from(payloadOf(out, entry.children[1]))).toEqual([0x6e, 0x63, 0x6c, 0x78, 0, 5, 0, 6, 0, 5, 0x80]);
    const outVideo = streamOf(ffprobeReport(out, 'mp4'), 'video');
    expect([outVideo.color_primaries, outVideo.color_transfer, outVideo.color_space, outVideo.color_range]).toEqual([
      'bt470bg', 'smpte170m', 'bt470bg', 'pc',
    ]);
    expect(ffmpegDecodeErrors(out, 'mp4')).toBe('');
  });

  it('writes the colour of a source into the vpcC of VP9 as well, where the codec string states none', () => {
    const colour = { primaries: 9, transfer: 16, matrix: 9, fullRange: true };

    const out = muxMp4({ video: { chunks: videoChunks(2), config: { codec: 'vp09.00.10.08' }, width: 64, height: 48, colour }, majorBrand: 'isom' });

    const entry = walkTracks(out)[0].entries[0];
    expect(entry.children.map((box) => box.type)).toEqual(['vpcC', 'colr']);
    // version 1, flags 0, profile 0, level 10, 8 bit | 4:2:0 co-located | full range, then BT.2020, PQ, BT.2020 nc
    expect([...payloadOf(out, entry.children[0])]).toEqual([1, 0, 0, 0, 0, 10, 0x83, 9, 16, 9, 0, 0]);
    expect(Array.from(payloadOf(out, entry.children[1]))).toEqual([0x6e, 0x63, 0x6c, 0x78, 0, 9, 0, 16, 0, 9, 0x80]);
  });

  it('refuses a VP9 codec string whose colour disagrees with the source colour', () => {
    const colour = { primaries: 9, transfer: 16, matrix: 9, fullRange: true };
    const config = { codec: 'vp09.00.10.08.01.01.01.01.00' };

    const run = () => muxMp4({ video: { chunks: videoChunks(2), config, width: 64, height: 48, colour }, majorBrand: 'isom' });

    expect(run).toThrow(EdgeUnsupportedError);
    expect(run).toThrow(/the codec string vp09\.00\.10\.08\.01\.01\.01\.01\.00 states colour 1\/1\/1 limited range, not the source's 9\/16\/9 full range/);
  });

  oracleTest('AV1: av01 with the encoder\'s av1C', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libaom-av1');
    const source = runFfmpeg(
      [
        ...testPatternInput({ ...SOURCE_VIDEO, width: 160, height: 120, seconds: 1 }),
        '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '45', '-b:v', '0', '-lag-in-frames', '0', '-pix_fmt', 'yuv420p',
        '-f', 'mp4',
      ],
      'mp4'
    );
    const sourceReport = ffprobeReport(new Uint8Array(source), 'mp4');
    const video = videoSource(source);

    const out = muxMp4({ video, majorBrand: 'isom' });

    const entry = walkTracks(out)[0].entries[0];
    expect(entry.type).toBe('av01');
    expect(payloadOf(out, entry.children.find((box) => box.type === 'av1C') as IsoBox)).toEqual(video.config.description);
    expect(readFtyp(out).compatibleBrands).toEqual(['isom', 'iso2', 'av01', 'mp41']);
    const outReport = ffprobeReport(out, 'mp4');
    expect(streamOf(outReport, 'video').codec_name).toBe('av1');
    expectSamePackets(packetsOf(outReport, streamOf(outReport, 'video')), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expect(ffmpegDecodeErrors(out, 'mp4')).toBe('');
  });

  oracleTest('HEVC: hvc1 with the encoder\'s hvcC', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libx265');
    const source = runFfmpeg(
      [
        ...testPatternInput({ ...SOURCE_VIDEO, width: 160, height: 120, seconds: 1 }),
        '-c:v', 'libx265', '-x265-params', 'bframes=0:log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
        '-f', 'mp4',
      ],
      'mp4'
    );
    const sourceReport = ffprobeReport(new Uint8Array(source), 'mp4');
    const video = videoSource(source);

    const out = muxMp4({ video, majorBrand: 'isom' });

    const entry = walkTracks(out)[0].entries[0];
    expect(entry.type).toBe('hvc1');
    expect(payloadOf(out, entry.children.find((box) => box.type === 'hvcC') as IsoBox)).toEqual(video.config.description);
    // An encoder that names its codec hev1 still gets an hvc1 entry: its parameter sets are in the hvcC
    const renamed = muxMp4({ video: { ...video, config: { ...video.config, codec: video.config.codec.replace('hvc1', 'hev1') } }, majorBrand: 'isom' });
    expect(walkTracks(renamed)[0].entries[0].type).toBe('hvc1');
    const outReport = ffprobeReport(out, 'mp4');
    expect(streamOf(outReport, 'video').codec_name).toBe('hevc');
    expectSamePackets(packetsOf(outReport, streamOf(outReport, 'video')), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expect(ffmpegDecodeErrors(out, 'mp4')).toBe('');
  });

  oracleTest('M4A: ftyp M4A, an esds that carries the AudioSpecificConfig, and an audio-only moov', ['ffmpeg', 'ffprobe'], () => {
    const source = aacM4a();
    const sourceReport = ffprobeReport(new Uint8Array(source), 'm4a');
    const sourceAudio = streamOf(sourceReport, 'audio');
    const audio = audioSource(source);

    const out = muxMp4({ audio, majorBrand: 'M4A ' });

    expect(readFtyp(out)).toEqual({ majorBrand: 'M4A ', compatibleBrands: ['M4A ', 'mp42', 'isom'] });
    expect(topLevelTypes(out)).toEqual(['ftyp', 'moov', 'mdat']);
    const tracks = walkTracks(out);
    expect(tracks.map((track) => track.handler)).toEqual(['soun']);
    const entry = tracks[0].entries[0];
    expect(entry.type).toBe('mp4a');
    const esds = readEsds(payloadOf(out, entry.children.find((box) => box.type === 'esds') as IsoBox));
    expect(esds.oti).toBe(0x40);
    expect(esds.streamType).toBe(0x15);
    expect(esds.asc).toEqual(audio.config.description);
    expect(readMdhdTimescale(out, trackBoxes(out)[0])).toBe(44100);
    expect(readElst(out, trackBoxes(out)[0])).toEqual([]);

    const outReport = ffprobeReport(out, 'm4a');
    const outAudio = streamOf(outReport, 'audio');
    expect(outAudio).toMatchObject({
      codec_name: 'aac',
      profile: 'LC',
      sample_rate: sourceAudio.sample_rate,
      channels: sourceAudio.channels,
    });
    expect(outReport.format.format_name).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expectSamePackets(packetsOf(outReport, outAudio), packetsOf(sourceReport, sourceAudio), audio.shiftSeconds);
    expect(ffmpegDecodeErrors(out, 'm4a')).toBe('');
  });

  oracleTest('video and audio together: interleaved chunks, and an empty edit for the track that starts late', ['ffmpeg', 'ffprobe'], () => {
    const source = h264AacMp4NoBFrames();
    const sourceReport = ffprobeReport(new Uint8Array(source), 'mp4');
    const delayMicros = 500_000;
    const video = videoSource(source);
    const audio = audioSource(source, delayMicros);

    const out = muxMp4({ video, audio, majorBrand: 'isom' });

    const tracks = walkTracks(out);
    expect(tracks.map((track) => track.handler)).toEqual(['vide', 'soun']);
    const [videoTrak, audioTrak] = trackBoxes(out);
    expect(readElst(out, videoTrak)).toEqual([]);
    // 500 ms in movie time (timescale 1000), an empty edit (media_time -1), then the media from its start
    const edits = readElst(out, audioTrak);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual([500, -1]);
    expect(edits[1][1]).toBe(0);

    // The chunks of the two tracks alternate in mdat: read every stco and merge them by file offset
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const offsets = [videoTrak, audioTrak].flatMap((trak, trackIndex) => {
      const stbl = child(out, child(out, child(out, trak, 'mdia'), 'minf'), 'stbl');
      const stco = child(out, stbl, 'stco');
      const count = view.getUint32(stco.payloadStart + 4);
      return Array.from({ length: count }, (_, i) => ({ offset: view.getUint32(stco.payloadStart + 8 + i * 4), trackIndex }));
    });
    const order = offsets.sort((a, b) => a.offset - b.offset).map((entry) => entry.trackIndex);
    const switches = order.filter((value, index) => index > 0 && value !== order[index - 1]).length;
    expect(switches).toBeGreaterThanOrEqual(3);

    const outReport = ffprobeReport(out, 'mp4');
    const outVideo = streamOf(outReport, 'video');
    const outAudio = streamOf(outReport, 'audio');
    expectSamePackets(packetsOf(outReport, outVideo), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expectSamePackets(packetsOf(outReport, outAudio), packetsOf(sourceReport, streamOf(sourceReport, 'audio')), audio.shiftSeconds);
    expect(Number(outAudio.start_time)).toBeCloseTo(delayMicros / MICROS, 3);
    expect(ffmpegDecodeErrors(out, 'mp4')).toBe('');
  });
});

function videoChunks(count: number, overrides: Partial<EncodedMediaChunk> = {}): EncodedMediaChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    data: Uint8Array.from([index + 1, 2, 3]),
    timestampMicros: index * 40_000,
    durationMicros: 40_000,
    isKeyFrame: index === 0,
    ...overrides,
  }));
}

const AVC_CONFIG: EncoderOutputConfig = {
  codec: 'avc1.64001f',
  description: Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0x00, 0x1f, 1, 0, 2, 0x68, 0xeb]),
};
const AAC_44100_STEREO_ASC = Uint8Array.from([0x12, 0x10]);

describe('muxMp4 refuses what it cannot describe truthfully', () => {
  const video = (chunks: EncodedMediaChunk[], config: EncoderOutputConfig = AVC_CONFIG) => ({ chunks, config, width: 64, height: 48 });
  const audioChunks = (): EncodedMediaChunk[] => videoChunks(3).map((chunk, index) => ({ ...chunk, timestampMicros: index * 23_220, durationMicros: 23_220, isKeyFrame: true }));
  const audio = (overrides: Partial<{ config: EncoderOutputConfig; sampleRate: number; channels: number }> = {}) => ({
    chunks: audioChunks(),
    config: { codec: 'mp4a.40.2', description: AAC_44100_STEREO_ASC },
    sampleRate: 44100,
    channels: 2,
    ...overrides,
  });

  function expectRefusal(run: () => unknown, message: RegExp): void {
    expect(run).toThrow(EdgeUnsupportedError);
    expect(run).toThrow(message);
  }

  it('writes the control file', () => {
    expect(topLevelTypes(muxMp4({ video: video(videoChunks(3)), audio: audio(), majorBrand: 'isom' }))).toEqual(['ftyp', 'moov', 'mdat']);
  });

  it('refuses to write no track', () => {
    expectRefusal(() => muxMp4({ majorBrand: 'isom' }), /no track/);
  });

  it('refuses an M4A with video, or without audio', () => {
    expectRefusal(() => muxMp4({ video: video(videoChunks(2)), majorBrand: 'M4A ' }), /audio and no video/);
  });

  it('refuses H.264 without the encoder\'s avcC, and the other records likewise', () => {
    expectRefusal(() => muxMp4({ video: video(videoChunks(2), { codec: 'avc1.64001f' }), majorBrand: 'isom' }), /avcC/);
    expectRefusal(() => muxMp4({ video: video(videoChunks(2), { codec: 'hvc1.1.6.L93.B0' }), majorBrand: 'isom' }), /hvcC/);
    expectRefusal(() => muxMp4({ video: video(videoChunks(2), { codec: 'av01.0.04M.08' }), majorBrand: 'isom' }), /av1C/);
  });

  it('refuses codecs MP4 has no sample entry for here', () => {
    expectRefusal(() => muxMp4({ video: video(videoChunks(2), { codec: 'vp8' }), majorBrand: 'isom' }), /vp8 has no MP4 sample entry/);
    expectRefusal(() => muxMp4({ audio: audio({ config: { codec: 'opus', description: Uint8Array.from([1]) } }), majorBrand: 'M4A ' }), /opus has no MP4 sample entry/);
    expectRefusal(() => muxMp4({ video: video(videoChunks(2), { codec: 'vp09.00' }), majorBrand: 'isom' }), /VP9 codec string/);
  });

  it('refuses chunks whose timestamps do not increase, which means the encoder reordered frames', () => {
    const chunks = videoChunks(3);
    chunks[2] = { ...chunks[2], timestampMicros: chunks[1].timestampMicros };
    expectRefusal(() => muxMp4({ video: video(chunks), majorBrand: 'isom' }), /strictly increasing/);
  });

  it('refuses a video stream that starts on a delta frame, an empty chunk, and a start before zero', () => {
    const delta = videoChunks(2);
    delta[0] = { ...delta[0], isKeyFrame: false };
    expectRefusal(() => muxMp4({ video: video(delta), majorBrand: 'isom' }), /delta frame/);

    const empty = videoChunks(2);
    empty[1] = { ...empty[1], data: new Uint8Array(0) };
    expectRefusal(() => muxMp4({ video: video(empty), majorBrand: 'isom' }), /empty chunk/);

    expectRefusal(
      () => muxMp4({ video: video(videoChunks(2).map((chunk) => ({ ...chunk, timestampMicros: chunk.timestampMicros - 1 }))), majorBrand: 'isom' }),
      /before time zero/
    );
  });

  it('refuses a lone chunk that carries no duration', () => {
    expectRefusal(
      () => muxMp4({ video: video([{ data: Uint8Array.from([1]), timestampMicros: 0, isKeyFrame: true }]), majorBrand: 'isom' }),
      /carries no duration/
    );
  });

  it('refuses audio whose AudioSpecificConfig disagrees with what was encoded', () => {
    expectRefusal(() => muxMp4({ audio: audio({ sampleRate: 48000 }), majorBrand: 'M4A ' }), /AudioSpecificConfig states 44100 Hz and 2 channels, not the 48000 Hz and 2 channels/);
    expectRefusal(() => muxMp4({ audio: audio({ config: { codec: 'mp4a.40.2' } }), majorBrand: 'M4A ' }), /AudioSpecificConfig/);
  });

  it('refuses a frame size that is not a whole positive number', () => {
    expectRefusal(() => muxMp4({ video: { ...video(videoChunks(2)), width: 0 }, majorBrand: 'isom' }), /frame size/);
  });

  it('refuses a colour description that is not whole code points', () => {
    const colour = (overrides: Partial<{ primaries: number; transfer: number; matrix: number }>) => ({
      primaries: 1, transfer: 1, matrix: 1, fullRange: false, ...overrides,
    });
    expectRefusal(() => muxMp4({ video: { ...video(videoChunks(2)), colour: colour({ primaries: 300 }) }, majorBrand: 'isom' }), /colour code points/);
    expectRefusal(() => muxMp4({ video: { ...video(videoChunks(2)), colour: colour({ matrix: 1.5 }) }, majorBrand: 'isom' }), /colour code points/);
    expectRefusal(() => muxMp4({ video: { ...video(videoChunks(2)), colour: colour({ transfer: -1 }) }, majorBrand: 'isom' }), /colour code points/);
  });
});

// ---------------------------------------------------------------------------------------------------
// ADTS
// ---------------------------------------------------------------------------------------------------

describe('muxAdtsStream', () => {
  oracleTest('writes an ADTS stream of the encoder\'s frames that the reference reads as AAC-LC', ['ffmpeg', 'ffprobe'], () => {
    const source = aacM4a();
    const sourceReport = ffprobeReport(new Uint8Array(source), 'm4a');
    const sourceAudio = streamOf(sourceReport, 'audio');
    const audio = audioSource(source);

    const out = muxAdtsStream(audio.chunks, audio.config, audio.sampleRate, audio.channels);

    // The first header, field by field: sync, MPEG-4 / no CRC, LC, index 4 (44.1 kHz), 1 channel, length, VBR
    const frameLength = audio.chunks[0].data.byteLength + 7;
    expect([...out.subarray(0, 7)]).toEqual([
      0xff, 0xf1, 0x50, 0x40 | (frameLength >> 11), (frameLength >> 3) & 0xff, ((frameLength & 7) << 5) | 0x1f, 0xfc,
    ]);
    expect(out.byteLength).toBe(audio.chunks.reduce((sum, chunk) => sum + chunk.data.byteLength + 7, 0));

    const outReport = ffprobeReport(out, 'aac');
    const outAudio = streamOf(outReport, 'audio');
    expect(outAudio).toMatchObject({ codec_name: 'aac', profile: 'LC', sample_rate: sourceAudio.sample_rate, channels: sourceAudio.channels });
    // The reference's ADTS reader returns each frame with its header
    expect(packetsOf(outReport, outAudio).map((packet) => packet.size)).toEqual(
      audio.chunks.map((chunk) => String(chunk.data.byteLength + 7))
    );
    expect(ffmpegDecodeErrors(out, 'aac')).toBe('');
  });

  it('refuses a rate it has no ADTS index for, a frame too long for the header, and a config that disagrees', () => {
    const chunks = [{ data: Uint8Array.from([1, 2]), timestampMicros: 0, isKeyFrame: true }];
    // AudioSpecificConfig with an explicit 100,000 Hz rate: AAC-LC, index 15, 24-bit rate, 2 channels
    const explicitRate = packBits([[2, 5], [15, 4], [100_000, 24], [2, 4]]);
    expect(() => muxAdtsStream(chunks, { codec: 'mp4a.40.2', description: explicitRate }, 100000, 2)).toThrow(/no ADTS sampling frequency index/);
    expect(() => buildAdtsHeader(0x2000, parseAacLcConfig(AAC_44100_STEREO_ASC))).toThrow(EdgeUnsupportedError);
    expect(() => muxAdtsStream(chunks, { codec: 'mp4a.40.2', description: AAC_44100_STEREO_ASC }, 48000, 2)).toThrow(/AudioSpecificConfig states/);
    expect(() => muxAdtsStream([], { codec: 'mp4a.40.2', description: AAC_44100_STEREO_ASC }, 44100, 2)).toThrow(/no frames/);
    expect(() => muxAdtsStream(chunks, { codec: 'opus' }, 44100, 2)).toThrow(/not AAC-LC/);
  });
});

// ---------------------------------------------------------------------------------------------------
// WebM
// ---------------------------------------------------------------------------------------------------

function webmChunks(walked: WalkedWebm, trackNumber: number): EncodedMediaChunk[] {
  const scaleMicros = walked.timecodeScale / 1000;
  return walked.blocks
    .filter((block) => block.track === trackNumber)
    .map((block) => ({ data: block.data, timestampMicros: block.timecode * scaleMicros, isKeyFrame: block.keyframe }));
}

function expectWebmStructure(out: Uint8Array): WalkedWebm {
  const walked = walkWebm(out);
  expect(walked.docType).toBe('webm');
  expect(walked.timecodeScale).toBe(1_000_000);
  // SeekHead points where the elements really are
  expect(walked.seeks.get(WEBM_IDS.INFO)).toBe(walked.positions.get(WEBM_IDS.INFO));
  expect(walked.seeks.get(WEBM_IDS.TRACKS)).toBe(walked.positions.get(WEBM_IDS.TRACKS));
  // Every cue names a cluster that exists, at its first block's time, and a video key frame starts it
  for (const cue of walked.cues) {
    expect(walked.clusterPositions).toContain(cue.clusterPosition);
    const first = walked.blocks.find((block) => block.clusterStart === cue.clusterPosition) as { timecode: number; keyframe: boolean; track: number };
    expect(first.timecode).toBe(cue.time);
    expect(first.keyframe).toBe(true);
    expect(first.track).toBe(cue.track);
  }
  if (walked.cues.length > 0) expect(walked.seeks.get(WEBM_IDS.CUES)).toBe(walked.positions.get(WEBM_IDS.CUES));
  // Block timecodes never go backwards
  const times = walked.blocks.map((block) => block.timecode);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  return walked;
}

describe('muxWebm writes the codec the encoder reported', () => {
  oracleTest('VP9 and Opus: V_VP9, A_OPUS with the encoder\'s OpusHead, cues and a readable, decodable file', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libvpx-vp9', 'libopus');
    const source = runFfmpeg(
      [
        ...testPatternInput({ ...SOURCE_VIDEO, seconds: 3 }),
        ...sineInput(48000, 3),
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-deadline', 'realtime', '-auto-alt-ref', '0', '-g', '25',
        '-c:a', 'libopus', '-shortest',
        '-f', 'webm',
      ],
      'webm'
    );
    const sourceBytes = new Uint8Array(source);
    const sourceReport = ffprobeReport(sourceBytes, 'webm');
    const walkedSource = walkWebm(sourceBytes);
    const sourceVideo = walkedSource.tracks.find((track) => track.codecId === 'V_VP9') as NonNullable<WalkedWebm['tracks'][number]>;
    const sourceOpus = walkedSource.tracks.find((track) => track.codecId === 'A_OPUS') as NonNullable<WalkedWebm['tracks'][number]>;
    const opusHead = sourceOpus.codecPrivate as Uint8Array;
    const preSkip = opusHead[10] | (opusHead[11] << 8);

    const out = muxWebm({
      video: {
        chunks: webmChunks(walkedSource, sourceVideo.number),
        config: { codec: 'vp09.00.10.08' },
        width: sourceVideo.width as number,
        height: sourceVideo.height as number,
      },
      audio: {
        chunks: webmChunks(walkedSource, sourceOpus.number),
        config: { codec: 'opus', description: opusHead },
        sampleRate: 48000,
        channels: sourceOpus.channels as number,
      },
    });

    const walked = expectWebmStructure(out);
    expect(walked.tracks).toHaveLength(2);
    const [video, audio] = walked.tracks;
    expect(video).toMatchObject({ number: 1, type: 1, codecId: 'V_VP9', width: sourceVideo.width, height: sourceVideo.height });
    expect(video.codecPrivate).toBeUndefined();
    expect(audio).toMatchObject({ number: 2, type: 2, codecId: 'A_OPUS', channels: sourceOpus.channels, samplingFrequency: 48000 });
    expect(audio.codecPrivate).toEqual(opusHead);
    expect(audio.codecDelayNs).toBe(Math.round((preSkip * 1e9) / 48000));
    expect(audio.seekPreRollNs).toBe(80_000_000);
    expect(walked.cues.length).toBeGreaterThanOrEqual(2);
    expect(walked.duration).toBeGreaterThan(2900);

    const outReport = ffprobeReport(out, 'webm');
    expect(outReport.format.format_name).toBe('matroska,webm');
    expect(streamOf(outReport, 'video').codec_name).toBe('vp9');
    expect(streamOf(outReport, 'audio')).toMatchObject({ codec_name: 'opus', channels: sourceOpus.channels });
    expectSamePackets(packetsOf(outReport, streamOf(outReport, 'video')), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expectSamePackets(packetsOf(outReport, streamOf(outReport, 'audio')), packetsOf(sourceReport, streamOf(sourceReport, 'audio')));
    expect(ffmpegDecodeErrors(out, 'webm')).toBe('');
    expect(ffmpegVideoFrameHashes(out, 'webm')).toEqual(ffmpegVideoFrameHashes(sourceBytes, 'webm'));
  });

  oracleTest('VP8: V_VP8', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libvpx');
    const source = runFfmpeg(
      [...testPatternInput({ ...SOURCE_VIDEO, seconds: 1 }), '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-auto-alt-ref', '0', '-f', 'webm'],
      'webm'
    );
    const walkedSource = walkWebm(new Uint8Array(source));
    const track = walkedSource.tracks[0];
    const sourceReport = ffprobeReport(new Uint8Array(source), 'webm');

    const out = muxWebm({
      video: { chunks: webmChunks(walkedSource, track.number), config: { codec: 'vp8' }, width: track.width as number, height: track.height as number },
    });

    expect(expectWebmStructure(out).tracks[0].codecId).toBe('V_VP8');
    const outReport = ffprobeReport(out, 'webm');
    expect(streamOf(outReport, 'video').codec_name).toBe('vp8');
    expectSamePackets(packetsOf(outReport, streamOf(outReport, 'video')), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expect(ffmpegDecodeErrors(out, 'webm')).toBe('');
  });

  oracleTest('VP9: the source colour description becomes a Colour element that the reference reads back', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libvpx-vp9');
    const source = runFfmpeg(
      [...testPatternInput({ ...SOURCE_VIDEO, seconds: 1 }), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-deadline', 'realtime', '-auto-alt-ref', '0', '-f', 'webm'],
      'webm'
    );
    const walkedSource = walkWebm(new Uint8Array(source));
    const track = walkedSource.tracks[0];
    expect(track.colour?.primaries).toBeUndefined();
    const colour = { primaries: 9, transfer: 16, matrix: 9, fullRange: false };

    const out = muxWebm({
      video: { chunks: webmChunks(walkedSource, track.number), config: { codec: 'vp09.00.10.08' }, width: track.width as number, height: track.height as number, colour },
    });

    // Matroska Colour: H.273 code points, Range 1 for broadcast (limited) range
    expect(expectWebmStructure(out).tracks[0].colour).toEqual({ matrix: 9, range: 1, transfer: 16, primaries: 9 });
    const outVideo = streamOf(ffprobeReport(out, 'webm'), 'video');
    // The matrix is not compared: a VP9 key frame header carries its own colour space, which the reference prefers
    expect([outVideo.color_primaries, outVideo.color_transfer, outVideo.color_range]).toEqual(['bt2020', 'smpte2084', 'tv']);
    expect(ffmpegDecodeErrors(out, 'webm')).toBe('');
  });

  it('writes no Colour element for a video whose colour is not stated', () => {
    expect(walkWebm(muxWebm({ video: vp9() })).tracks[0].colour).toBeUndefined();
  });

  it('refuses a colour description that is not whole code points', () => {
    const colour = { primaries: 256, transfer: 1, matrix: 1, fullRange: false };
    expectRefusal(() => muxWebm({ video: { ...vp9(), colour } }), /colour code points/);
  });

  oracleTest('AV1: V_AV1 with the av1C as CodecPrivate', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libaom-av1');
    const source = runFfmpeg(
      [
        ...testPatternInput({ ...SOURCE_VIDEO, width: 160, height: 120, seconds: 1 }),
        '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '45', '-b:v', '0', '-lag-in-frames', '0', '-pix_fmt', 'yuv420p',
        '-f', 'mp4',
      ],
      'mp4'
    );
    const sourceReport = ffprobeReport(new Uint8Array(source), 'mp4');
    const video = videoSource(source);

    const out = muxWebm({ video });

    const walked = expectWebmStructure(out);
    expect(walked.tracks[0]).toMatchObject({ codecId: 'V_AV1', width: 160, height: 120 });
    expect(walked.tracks[0].codecPrivate).toEqual(video.config.description);
    const outReport = ffprobeReport(out, 'webm');
    expect(streamOf(outReport, 'video').codec_name).toBe('av1');
    expectSamePackets(packetsOf(outReport, streamOf(outReport, 'video')), packetsOf(sourceReport, streamOf(sourceReport, 'video')));
    expect(ffmpegDecodeErrors(out, 'webm')).toBe('');
  });

  function vp9(overrides: Partial<EncoderOutputConfig> = {}) {
    return { chunks: videoChunks(3), config: { codec: 'vp09.00.10.08', ...overrides }, width: 64, height: 48 };
  }
  const opusHead = (channels: number) =>
    Uint8Array.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
  const opus = (config: EncoderOutputConfig) => ({ chunks: videoChunks(3), config, sampleRate: 48000, channels: 2 });

  function expectRefusal(run: () => unknown, message: RegExp): void {
    expect(run).toThrow(EdgeUnsupportedError);
    expect(run).toThrow(message);
  }

  it('writes the control file with the OpusHead pre-skip as CodecDelay', () => {
    const walked = walkWebm(muxWebm({ video: vp9(), audio: opus({ codec: 'opus', description: opusHead(2) }) }));

    // pre-skip 0x0138 = 312 samples at 48 kHz = 6.5 ms
    expect(walked.tracks[1].codecDelayNs).toBe(6_500_000);
  });

  it('refuses codecs WebM does not carry', () => {
    expectRefusal(() => muxWebm({ video: vp9({ codec: 'avc1.64001f', description: Uint8Array.from([1]) }) }), /avc1\.64001f is not a codec WebM carries/);
    expectRefusal(() => muxWebm({ video: vp9({ codec: 'hvc1.1.6.L93.B0' }) }), /not a codec WebM carries/);
    expectRefusal(() => muxWebm({ video: vp9(), audio: opus({ codec: 'mp4a.40.2', description: AAC_44100_STEREO_ASC }) }), /mp4a\.40\.2 is not a codec WebM carries/);
  });

  it('refuses AV1 without its av1C, and Opus without a valid OpusHead', () => {
    expectRefusal(() => muxWebm({ video: vp9({ codec: 'av01.0.04M.08' }) }), /av1C/);
    expectRefusal(() => muxWebm({ video: vp9(), audio: opus({ codec: 'opus' }) }), /OpusHead/);
    expectRefusal(() => muxWebm({ video: vp9(), audio: opus({ codec: 'opus', description: Uint8Array.from([1, 2, 3]) }) }), /not an OpusHead/);
    expectRefusal(() => muxWebm({ video: vp9(), audio: opus({ codec: 'opus', description: opusHead(1) }) }), /states 1 channels, not the 2 encoded/);
  });

  it('refuses chunks that are not in increasing millisecond order, or a stream that starts on a delta frame', () => {
    const reordered = vp9();
    reordered.chunks[2] = { ...reordered.chunks[2], timestampMicros: reordered.chunks[0].timestampMicros };
    expectRefusal(() => muxWebm({ video: reordered }), /strictly increasing/);
    const delta = vp9();
    delta.chunks[0] = { ...delta.chunks[0], isKeyFrame: false };
    expectRefusal(() => muxWebm({ video: delta }), /delta frame/);
    expectRefusal(() => muxWebm({}), /no track/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Ogg Opus
// ---------------------------------------------------------------------------------------------------

describe('muxOggOpus', () => {
  oracleTest('writes the encoder\'s OpusHead and packets in pages with valid checksums and counted granule positions', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('libopus');
    const source = runFfmpeg([...sineInput(48000, 4), '-c:a', 'libopus', '-f', 'ogg'], 'opus');
    const sourceReport = ffprobeReport(new Uint8Array(source), 'opus');
    const sourcePages = walkOggPages(new Uint8Array(source));
    const sourcePackets = sourcePages.flatMap((page) => page.packets);
    const [opusHead, , ...audioPackets] = sourcePackets;
    const preSkip = opusHead[10] | (opusHead[11] << 8);

    const out = muxOggOpus(
      audioPackets.map((data, index) => ({ data, timestampMicros: index * 20_000, isKeyFrame: true })),
      opusHead
    );

    const pages = walkOggPages(out);
    expect(pages.every((page) => page.crcValid)).toBe(true);
    expect(pages).toHaveLength(2 + audioPackets.length);
    expect(pages[0].flags).toBe(0x02);
    expect(pages[0].packets[0]).toEqual(opusHead);
    expect(new TextDecoder().decode(pages[1].packets[0].subarray(0, 8))).toBe('OpusTags');
    expect(pages[pages.length - 1].flags).toBe(0x04);
    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index));
    expect(new Set(pages.map((page) => page.serial)).size).toBe(1);
    expect(pages[0].granule).toBe(0n);
    expect(pages[1].granule).toBe(0n);
    // The reference wrote its own granule positions for these very packets. Wherever one of its pages ends on a
    // packet, the muxed page that ends on the same packet must carry the same granule (RFC 7845 4).
    const referenceGranules = new Map<number, bigint>();
    let packetIndex = -1;
    for (const page of sourcePages) {
      packetIndex += page.packets.length;
      if (page.packets.length > 0) referenceGranules.set(packetIndex - 2, page.granule);
    }
    const muxedGranules = new Map<number, bigint>();
    let muxedIndex = -1;
    for (const page of pages) {
      muxedIndex += page.packets.length;
      if (page.packets.length > 0) muxedGranules.set(muxedIndex - 2, page.granule);
    }
    const lastAudioIndex = audioPackets.length - 1;
    let compared = 0;
    for (const [index, granule] of referenceGranules) {
      if (index < 0 || index === lastAudioIndex) continue;
      expect(muxedGranules.get(index)).toBe(granule);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(3);
    // The reference may cut the final granule to the input length; the muxer, which does not know it, must not exceed
    // the reference by a whole packet nor fall short of it
    const lastReference = referenceGranules.get(lastAudioIndex) as bigint;
    const lastMuxed = muxedGranules.get(lastAudioIndex) as bigint;
    expect(lastMuxed >= lastReference && lastMuxed - lastReference < 960n).toBe(true);
    expect(preSkip).toBeGreaterThan(0);

    const outReport = ffprobeReport(out, 'opus');
    const outAudio = streamOf(outReport, 'audio');
    expect(outAudio).toMatchObject({ codec_name: 'opus', channels: streamOf(sourceReport, 'audio').channels });
    expect(packetsOf(outReport, outAudio).map((packet) => packet.data_hash)).toEqual(
      packetsOf(sourceReport, streamOf(sourceReport, 'audio')).map((packet) => packet.data_hash)
    );
    expect(ffmpegDecodeErrors(out, 'opus')).toBe('');
    // What the reference reads as the length of the file, and how many samples it decodes, must not grow
    const sourceDuration = Number(sourceReport.format.duration);
    const outDuration = Number(outReport.format.duration);
    expect(Math.abs(outDuration - sourceDuration)).toBeLessThan(0.02);
    const sourceBytes = ffmpegDecodedAudioBytes(new Uint8Array(source), 'opus');
    const outBytes = ffmpegDecodedAudioBytes(out, 'opus');
    expect(outBytes >= sourceBytes && outBytes - sourceBytes < 960 * 2 * 2).toBe(true);
  });

  it('reads the frame count and size from the TOC byte of the packet', () => {
    // config 31 (CELT fullband 20 ms) with code 0: one 960-sample frame; code 1: two frames; code 3 with 3 frames
    expect(opusPacketSamples(Uint8Array.from([31 << 3, 0]))).toBe(960);
    expect(opusPacketSamples(Uint8Array.from([(31 << 3) | 1, 0, 0]))).toBe(1920);
    expect(opusPacketSamples(Uint8Array.from([(31 << 3) | 3, 3, 0]))).toBe(2880);
    // config 16 (CELT narrowband 2.5 ms) and config 3 (SILK narrowband 60 ms)
    expect(opusPacketSamples(Uint8Array.from([16 << 3, 0]))).toBe(120);
    expect(opusPacketSamples(Uint8Array.from([3 << 3, 0]))).toBe(2880);
  });

  it('refuses a packet that claims more than 120 ms, an empty stream and a missing OpusHead', () => {
    const head = Uint8Array.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    const packet = { data: Uint8Array.from([(31 << 3) | 3, 48, 0]), timestampMicros: 0, isKeyFrame: true };
    expect(() => muxOggOpus([packet], head)).toThrow(/beyond 120 ms/);
    expect(() => muxOggOpus([], head)).toThrow(/no packets/);
    expect(() => muxOggOpus([{ ...packet, data: Uint8Array.from([31 << 3]) }], undefined)).toThrow(/no OpusHead/);
    expect(() => muxOggOpus([{ ...packet, data: Uint8Array.from([31 << 3]) }], Uint8Array.from([1, 2, 3]))).toThrow(/not an OpusHead/);
    expect(() => muxOggOpus([{ ...packet, data: new Uint8Array(0) }], head)).toThrow(EdgeUnsupportedError);
  });
});
