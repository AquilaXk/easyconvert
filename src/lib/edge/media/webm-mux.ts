/**
 * WebM (Matroska subset, RFC 8794 and the Matroska specification) muxer for chunks produced by WebCodecs
 * encoders.
 *
 * The CodecID follows the codec string the encoder reports: vp8 -> V_VP8, vp09.* -> V_VP9, av01.* -> V_AV1
 * (CodecPrivate is the av1C record) and opus -> A_OPUS (CodecPrivate is the OpusHead, CodecDelay its
 * pre-skip). Codecs WebM does not allow (H.264, HEVC, AAC) and encoders that did not report the records the
 * mapping needs throw EdgeUnsupportedError. All master elements are written with known sizes, the clusters
 * start on video key frames, and a SeekHead and Cues make the file seekable.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import type { EncodedMediaChunk, EncoderOutputConfig, VideoColour } from './media-types';
import { isStorableColour } from './video-colour';

export const WEBM_MUX_MAX_BLOCKS_PER_TRACK = 1_000_000;

const NS_PER_MS = 1_000_000;
const MICROS_PER_MS = 1_000;
const TIMECODE_SCALE_NS = NS_PER_MS;
/** A cluster spans less than this, so block timecodes stay inside the signed 16-bit offset. */
const MAX_CLUSTER_SPAN_MS = 30_000;
/** A video key frame starts a new cluster once the current one is at least this long. */
const MIN_CLUSTER_SPAN_MS = 1_000;
const OPUS_SAMPLE_RATE = 48_000;
const OPUS_SEEK_PRE_ROLL_NS = 80 * NS_PER_MS;
const OPUS_HEAD_MIN_BYTES = 19;
const OPUS_HEAD_MAGIC = 'OpusHead';
const OPUS_HEAD_PRE_SKIP_OFFSET = 10;
const OPUS_HEAD_CHANNELS_OFFSET = 9;
const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;
const VIDEO_TRACK_NUMBER = 1;
const AUDIO_TRACK_NUMBER = 2;
const KEYFRAME_FLAG = 0x80;
const SEEK_POSITION_BYTES = 4;
const WRITING_APP = 'EasyConvert WebCodecs';
const DOC_TYPE_VERSION = 4;
const DOC_TYPE_READ_VERSION = 2;

function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`WebM output: ${message}; the server engine converts this file.`);
}

type Part = number[] | Uint8Array;

function concat(parts: Part[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** EBML element ids: the id's own bytes, big-endian. */
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) out.unshift(value % 256);
  return out;
}

/** EBML data size (RFC 8794 4): the shortest vint that holds `size` without being the reserved all-ones value. */
function sizeBytes(size: number): number[] {
  for (let length = 1; length <= 8; length++) {
    if (size < 2 ** (7 * length) - 1) {
      const out: number[] = [];
      let rest = size;
      for (let i = 0; i < length; i++) {
        out.unshift(rest % 256);
        rest = Math.floor(rest / 256);
      }
      out[0] |= 0x80 >> (length - 1);
      return out;
    }
  }
  throw refuse('an element is larger than EBML can size');
}

function elementOf(id: number, payload: Part[]): Uint8Array {
  const body = concat(payload);
  return concat([idBytes(id), sizeBytes(body.length), body]);
}

function element(id: number, ...payload: Part[]): Uint8Array {
  return elementOf(id, payload);
}

function uint(id: number, value: number, width?: number): Uint8Array {
  const body: number[] = [];
  let rest = value;
  do {
    body.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  while (width !== undefined && body.length < width) body.unshift(0);
  return element(id, body);
}

function float64(id: number, value: number): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setFloat64(0, value);
  return element(id, body);
}

function text(id: number, value: string): Uint8Array {
  return element(id, Array.from(value, (char) => char.charCodeAt(0)));
}

// ---------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------

export interface WebmVideoInput {
  chunks: EncodedMediaChunk[];
  config: EncoderOutputConfig;
  width: number;
  height: number;
  /** The source's colour description; written as the track's Colour element. */
  colour?: VideoColour;
}

export interface WebmAudioInput {
  chunks: EncodedMediaChunk[];
  config: EncoderOutputConfig;
  sampleRate: number;
  channels: number;
}

export interface WebmMuxInput {
  video?: WebmVideoInput;
  audio?: WebmAudioInput;
}

// ---------------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------------

const ID = {
  EBML: 0x1a45dfa3,
  EBML_VERSION: 0x4286,
  EBML_READ_VERSION: 0x42f7,
  EBML_MAX_ID_LENGTH: 0x42f2,
  EBML_MAX_SIZE_LENGTH: 0x42f3,
  DOC_TYPE: 0x4282,
  DOC_TYPE_VERSION: 0x4287,
  DOC_TYPE_READ_VERSION: 0x4285,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  MUXING_APP: 0x4d80,
  WRITING_APP: 0x5741,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_UID: 0x73c5,
  TRACK_TYPE: 0x83,
  FLAG_LACING: 0x9c,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CODEC_DELAY: 0x56aa,
  SEEK_PRE_ROLL: 0x56bb,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  COLOUR: 0x55b0,
  MATRIX_COEFFICIENTS: 0x55b1,
  RANGE: 0x55b9,
  TRANSFER_CHARACTERISTICS: 0x55ba,
  PRIMARIES: 0x55bb,
  AUDIO: 0xe1,
  SAMPLING_FREQUENCY: 0xb5,
  CHANNELS: 0x9f,
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7,
  CUE_CLUSTER_POSITION: 0xf1,
} as const;

interface TrackBlocks {
  number: number;
  chunks: EncodedMediaChunk[];
  isVideo: boolean;
}

function requireIncreasing(kind: string, chunks: EncodedMediaChunk[]): void {
  if (chunks.length === 0) throw refuse(`the ${kind} track has no chunks`);
  if (chunks.length > WEBM_MUX_MAX_BLOCKS_PER_TRACK) {
    throw refuse(`the ${kind} track has more than ${WEBM_MUX_MAX_BLOCKS_PER_TRACK} chunks (block limit)`);
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const chunk of chunks) {
    if (chunk.data.byteLength === 0) throw refuse(`the ${kind} track has an empty chunk`);
    if (chunk.timestampMicros < 0) throw refuse(`the ${kind} track starts before time zero`);
    if (Math.round(chunk.timestampMicros / MICROS_PER_MS) <= previous) {
      throw refuse(`the ${kind} chunks do not have strictly increasing millisecond timestamps (the encoder reordered frames)`);
    }
    previous = Math.round(chunk.timestampMicros / MICROS_PER_MS);
  }
}

/** Range values of the Matroska Colour element: 1 is broadcast (limited), 2 is full. */
const COLOUR_RANGE_LIMITED = 1;
const COLOUR_RANGE_FULL = 2;

/** The Colour master element: H.273 code points are stored as they are, the range flag as Matroska's Range. */
function colourElement(colour: VideoColour): Uint8Array {
  if (!isStorableColour(colour)) {
    throw refuse('the colour description holds colour code points that are not whole numbers from 0 to 255');
  }
  return element(
    ID.COLOUR,
    uint(ID.MATRIX_COEFFICIENTS, colour.matrix),
    uint(ID.RANGE, colour.fullRange ? COLOUR_RANGE_FULL : COLOUR_RANGE_LIMITED),
    uint(ID.TRANSFER_CHARACTERISTICS, colour.transfer),
    uint(ID.PRIMARIES, colour.primaries)
  );
}

function videoTrackEntry(input: WebmVideoInput): Uint8Array {
  const codec = input.config.codec;
  let codecId: string;
  let codecPrivate: Uint8Array | undefined;
  if (codec === 'vp8') {
    codecId = 'V_VP8';
  } else if (codec.startsWith('vp09.')) {
    codecId = 'V_VP9';
  } else if (codec.startsWith('av01.')) {
    codecId = 'V_AV1';
    if (!input.config.description || input.config.description.byteLength === 0) {
      throw refuse(`the encoder reported no av1C decoder configuration record for ${codec}`);
    }
    codecPrivate = input.config.description;
  } else {
    throw refuse(`${codec} is not a codec WebM carries (VP8, VP9 and AV1 are)`);
  }
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    throw refuse('the video frame size is not a positive whole number');
  }
  return element(
    ID.TRACK_ENTRY,
    uint(ID.TRACK_NUMBER, VIDEO_TRACK_NUMBER),
    uint(ID.TRACK_UID, VIDEO_TRACK_NUMBER),
    uint(ID.TRACK_TYPE, TRACK_TYPE_VIDEO),
    uint(ID.FLAG_LACING, 0),
    text(ID.CODEC_ID, codecId),
    ...(codecPrivate ? [element(ID.CODEC_PRIVATE, codecPrivate)] : []),
    element(
      ID.VIDEO,
      uint(ID.PIXEL_WIDTH, input.width),
      uint(ID.PIXEL_HEIGHT, input.height),
      ...(input.colour ? [colourElement(input.colour)] : [])
    )
  );
}

/** The pre-skip of an OpusHead (RFC 7845 5.1), after checking it is one for this many channels. */
function opusPreSkip(head: Uint8Array, channels: number): number {
  const magic = String.fromCharCode(...head.subarray(0, OPUS_HEAD_MAGIC.length));
  if (head.byteLength < OPUS_HEAD_MIN_BYTES || magic !== OPUS_HEAD_MAGIC || head[OPUS_HEAD_MAGIC.length] !== 1) {
    throw refuse('the encoder reported a decoder configuration that is not an OpusHead');
  }
  if (head[OPUS_HEAD_CHANNELS_OFFSET] !== channels) {
    throw refuse(`the OpusHead states ${head[OPUS_HEAD_CHANNELS_OFFSET]} channels, not the ${channels} encoded`);
  }
  return new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(OPUS_HEAD_PRE_SKIP_OFFSET, true);
}

function audioTrackEntry(input: WebmAudioInput): Uint8Array {
  if (input.config.codec !== 'opus') throw refuse(`${input.config.codec} is not a codec WebM carries here (Opus is)`);
  const head = input.config.description;
  if (!head || head.byteLength === 0) throw refuse('the encoder reported no OpusHead decoder configuration record');
  const preSkip = opusPreSkip(head, input.channels);
  return element(
    ID.TRACK_ENTRY,
    uint(ID.TRACK_NUMBER, AUDIO_TRACK_NUMBER),
    uint(ID.TRACK_UID, AUDIO_TRACK_NUMBER),
    uint(ID.TRACK_TYPE, TRACK_TYPE_AUDIO),
    uint(ID.FLAG_LACING, 0),
    text(ID.CODEC_ID, 'A_OPUS'),
    element(ID.CODEC_PRIVATE, head),
    // Matroska codec mapping for Opus: CodecDelay is the pre-skip in nanoseconds, SeekPreRoll is 80 ms
    uint(ID.CODEC_DELAY, Math.round((preSkip * 1e9) / OPUS_SAMPLE_RATE)),
    uint(ID.SEEK_PRE_ROLL, OPUS_SEEK_PRE_ROLL_NS),
    element(
      ID.AUDIO,
      // Matroska codec mapping for Opus: the decoder always outputs 48 kHz; the rate the encoder was fed is in OpusHead
      float64(ID.SAMPLING_FREQUENCY, OPUS_SAMPLE_RATE),
      uint(ID.CHANNELS, input.channels)
    )
  );
}

// ---------------------------------------------------------------------------------------------------
// Blocks and clusters
// ---------------------------------------------------------------------------------------------------

interface TimedBlock {
  track: number;
  isVideo: boolean;
  timecodeMs: number;
  key: boolean;
  data: Uint8Array;
}

function simpleBlock(block: TimedBlock, clusterTimecodeMs: number): Uint8Array {
  const relative = block.timecodeMs - clusterTimecodeMs;
  const header = [0x80 | block.track, (relative >> 8) & 0xff, relative & 0xff, block.key ? KEYFRAME_FLAG : 0];
  return element(ID.SIMPLE_BLOCK, header, block.data);
}

interface BuiltCluster {
  bytes: Uint8Array;
  timecodeMs: number;
  startsOnVideoKey: boolean;
}

/** Splits the time-ordered blocks into clusters: at video key frames after a minimum span, and before 30 s. */
function buildClusters(blocks: TimedBlock[]): BuiltCluster[] {
  const clusters: BuiltCluster[] = [];
  let group: TimedBlock[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const timecodeMs = group[0].timecodeMs;
    clusters.push({
      bytes: elementOf(ID.CLUSTER, [uint(ID.CLUSTER_TIMECODE, timecodeMs), ...group.map((block) => simpleBlock(block, timecodeMs))]),
      timecodeMs,
      startsOnVideoKey: group[0].isVideo && group[0].key,
    });
    group = [];
  };
  for (const block of blocks) {
    if (group.length > 0) {
      const span = block.timecodeMs - group[0].timecodeMs;
      const keyBoundary = block.isVideo && block.key && span >= MIN_CLUSTER_SPAN_MS;
      if (keyBoundary || span >= MAX_CLUSTER_SPAN_MS) flush();
    }
    group.push(block);
  }
  flush();
  return clusters;
}

/** One CuePoint per cluster that starts on a video key frame; none when there is no such cluster. */
function cuesElement(clusterPositions: number[], clusters: BuiltCluster[]): Uint8Array | undefined {
  const points = clusters.flatMap((cluster, index) =>
    cluster.startsOnVideoKey
      ? [
          element(
            ID.CUE_POINT,
            uint(ID.CUE_TIME, cluster.timecodeMs),
            element(
              ID.CUE_TRACK_POSITIONS,
              uint(ID.CUE_TRACK, VIDEO_TRACK_NUMBER),
              uint(ID.CUE_CLUSTER_POSITION, clusterPositions[index])
            )
          ),
        ]
      : []
  );
  return points.length > 0 ? elementOf(ID.CUES, points) : undefined;
}

function seekEntry(id: number, position: number): Uint8Array {
  return element(ID.SEEK, element(ID.SEEK_ID, idBytes(id)), uint(ID.SEEK_POSITION, position, SEEK_POSITION_BYTES));
}

/** Writes a WebM file from encoded chunks and the encoders' own decoder configurations. */
export function muxWebm(input: WebmMuxInput): Uint8Array {
  if (!input.video && !input.audio) throw refuse('there is no track to write');
  const entries: Uint8Array[] = [];
  const tracks: TrackBlocks[] = [];
  if (input.video) {
    requireIncreasing('video', input.video.chunks);
    if (!input.video.chunks[0].isKeyFrame) throw refuse('the video stream starts on a delta frame');
    entries.push(videoTrackEntry(input.video));
    tracks.push({ number: VIDEO_TRACK_NUMBER, chunks: input.video.chunks, isVideo: true });
  }
  if (input.audio) {
    requireIncreasing('audio', input.audio.chunks);
    entries.push(audioTrackEntry(input.audio));
    tracks.push({ number: AUDIO_TRACK_NUMBER, chunks: input.audio.chunks, isVideo: false });
  }

  // Blocks in time order across tracks; video first on a tie
  const blocks: TimedBlock[] = tracks.flatMap((track) =>
    track.chunks.map((chunk) => ({
      track: track.number,
      isVideo: track.isVideo,
      timecodeMs: Math.round(chunk.timestampMicros / MICROS_PER_MS),
      key: track.isVideo ? chunk.isKeyFrame : true,
      data: chunk.data,
    }))
  );
  blocks.sort((a, b) => a.timecodeMs - b.timecodeMs || a.track - b.track);

  const endMs = Math.max(
    ...tracks.map((track) => {
      const last = track.chunks[track.chunks.length - 1];
      return (last.timestampMicros + (last.durationMicros ?? 0)) / MICROS_PER_MS;
    })
  );

  const header = element(
    ID.EBML,
    uint(ID.EBML_VERSION, 1),
    uint(ID.EBML_READ_VERSION, 1),
    uint(ID.EBML_MAX_ID_LENGTH, 4),
    uint(ID.EBML_MAX_SIZE_LENGTH, 8),
    text(ID.DOC_TYPE, 'webm'),
    uint(ID.DOC_TYPE_VERSION, DOC_TYPE_VERSION),
    uint(ID.DOC_TYPE_READ_VERSION, DOC_TYPE_READ_VERSION)
  );
  const info = element(
    ID.INFO,
    uint(ID.TIMECODE_SCALE, TIMECODE_SCALE_NS),
    float64(ID.DURATION, endMs),
    text(ID.MUXING_APP, WRITING_APP),
    text(ID.WRITING_APP, WRITING_APP)
  );
  const tracksElement = element(ID.TRACKS, ...entries);
  const clusters = buildClusters(blocks);

  // Seek entries have a fixed width, so the positions they record can be computed before the SeekHead is
  // written. Cues are listed only when there are cue points, which depends on the cluster layout alone.
  const hasCues = clusters.some((cluster) => cluster.startsOnVideoKey);
  const seekHeadBytes = elementOf(
    ID.SEEK_HEAD,
    [seekEntry(ID.INFO, 0), seekEntry(ID.TRACKS, 0), ...(hasCues ? [seekEntry(ID.CUES, 0)] : [])]
  ).byteLength;
  const infoPosition = seekHeadBytes;
  const tracksPosition = infoPosition + info.byteLength;
  let clusterCursor = tracksPosition + tracksElement.byteLength;
  const clusterPositions = clusters.map((cluster) => {
    const position = clusterCursor;
    clusterCursor += cluster.bytes.byteLength;
    return position;
  });
  const cuesPosition = clusterCursor;
  const cues = cuesElement(clusterPositions, clusters);
  const seekHead = elementOf(ID.SEEK_HEAD, [
    seekEntry(ID.INFO, infoPosition),
    seekEntry(ID.TRACKS, tracksPosition),
    ...(cues ? [seekEntry(ID.CUES, cuesPosition)] : []),
  ]);

  const segment = elementOf(ID.SEGMENT, [
    seekHead,
    info,
    tracksElement,
    ...clusters.map((cluster) => cluster.bytes),
    ...(cues ? [cues] : []),
  ]);
  return concat([header, segment]);
}
