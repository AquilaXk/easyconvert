/**
 * Independent Matroska/WebM (EBML, RFC 8794) reader for tests. It is written from the specification and shares
 * no code with the muxer under test: it lists the tracks, every block with its absolute timecode, the cues and
 * the clusters' file positions, and it throws on any malformed element.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CODEC_DELAY = 0x56aa;
const ID_SEEK_PRE_ROLL = 0x56bb;
const ID_VIDEO = 0xe0;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_AUDIO = 0xe1;
const ID_SAMPLING_FREQUENCY = 0xb5;
const ID_CHANNELS = 0x9f;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
const ID_DOCTYPE = 0x4282;

const MAX_ELEMENTS = 1_000_000;
const MAX_VINT_BYTES = 8;

export interface EbmlElement {
  id: number;
  /** File offset of the element id. */
  start: number;
  /** File offset of the first payload byte. */
  payload: number;
  /** One past the last payload byte. */
  end: number;
}

export interface WalkedTrack {
  number: number;
  type: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  codecDelayNs?: number;
  seekPreRollNs?: number;
  width?: number;
  height?: number;
  samplingFrequency?: number;
  channels?: number;
}

export interface WalkedBlock {
  track: number;
  /** Cluster timecode plus the block's relative timecode, in TimecodeScale units. */
  timecode: number;
  keyframe: boolean;
  data: Uint8Array;
  clusterStart: number;
}

export interface WalkedCue {
  time: number;
  track: number;
  /** Offset of the cluster from the start of the segment payload. */
  clusterPosition: number;
}

export interface WalkedWebm {
  docType: string;
  timecodeScale: number;
  duration?: number;
  segmentPayload: number;
  tracks: WalkedTrack[];
  blocks: WalkedBlock[];
  cues: WalkedCue[];
  /** Offsets from the segment payload of every Cluster element. */
  clusterPositions: number[];
  /** What the SeekHead points at: element id to position from the segment payload. */
  seeks: Map<number, number>;
  /** Where each top-level element of the segment actually is, from the segment payload. */
  positions: Map<number, number>;
}

function readId(data: Uint8Array, offset: number): { id: number; length: number } {
  const first = data[offset];
  if (first === undefined || first === 0) throw new Error(`bad EBML id at ${offset}`);
  const length = Math.clz32(first) - 23;
  if (length > 4) throw new Error(`EBML id longer than 4 bytes at ${offset}`);
  let id = 0;
  for (let i = 0; i < length; i++) {
    const byte = data[offset + i];
    if (byte === undefined) throw new Error(`EBML id truncated at ${offset}`);
    id = id * 256 + byte;
  }
  return { id, length };
}

function readSize(data: Uint8Array, offset: number): { size: number; length: number } {
  const first = data[offset];
  if (first === undefined || first === 0) throw new Error(`bad EBML size at ${offset}`);
  const length = Math.clz32(first) - 23;
  if (length > MAX_VINT_BYTES) throw new Error(`EBML size longer than 8 bytes at ${offset}`);
  let size = first & (0xff >> length);
  let allOnes = size === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = data[offset + i];
    if (byte === undefined) throw new Error(`EBML size truncated at ${offset}`);
    size = size * 256 + byte;
    allOnes = allOnes && byte === 0xff;
  }
  if (allOnes) throw new Error(`unknown-size element at ${offset}`);
  return { size, length };
}

function listElements(data: Uint8Array, start: number, end: number): EbmlElement[] {
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    const { id, length: idLength } = readId(data, offset);
    const { size, length: sizeLength } = readSize(data, offset + idLength);
    const payload = offset + idLength + sizeLength;
    if (payload + size > end) throw new Error(`element ${id.toString(16)} at ${offset} overruns its parent`);
    elements.push({ id, start: offset, payload, end: payload + size });
    offset = payload + size;
    if (elements.length > MAX_ELEMENTS) throw new Error('too many elements');
  }
  return elements;
}

function uintOf(data: Uint8Array, element: EbmlElement): number {
  let value = 0;
  for (let i = element.payload; i < element.end; i++) value = value * 256 + data[i];
  return value;
}

function floatOf(data: Uint8Array, element: EbmlElement): number {
  const view = new DataView(data.buffer, data.byteOffset + element.payload, element.end - element.payload);
  if (view.byteLength === 4) return view.getFloat32(0);
  if (view.byteLength === 8) return view.getFloat64(0);
  throw new Error(`float of ${view.byteLength} bytes`);
}

function stringOf(data: Uint8Array, element: EbmlElement): string {
  return new TextDecoder().decode(data.subarray(element.payload, element.end));
}

function one(elements: EbmlElement[], id: number): EbmlElement | undefined {
  return elements.find((element) => element.id === id);
}

function readVintValue(data: Uint8Array, offset: number): { value: number; length: number } {
  const { size, length } = readSize(data, offset);
  return { value: size, length };
}

function parseTrack(data: Uint8Array, entry: EbmlElement): WalkedTrack {
  const parts = listElements(data, entry.payload, entry.end);
  const number = one(parts, ID_TRACK_NUMBER);
  const type = one(parts, ID_TRACK_TYPE);
  const codecId = one(parts, ID_CODEC_ID);
  if (!number || !type || !codecId) throw new Error('track entry without number, type or codec id');
  const track: WalkedTrack = { number: uintOf(data, number), type: uintOf(data, type), codecId: stringOf(data, codecId) };
  const priv = one(parts, ID_CODEC_PRIVATE);
  if (priv) track.codecPrivate = data.slice(priv.payload, priv.end);
  const delay = one(parts, ID_CODEC_DELAY);
  if (delay) track.codecDelayNs = uintOf(data, delay);
  const preRoll = one(parts, ID_SEEK_PRE_ROLL);
  if (preRoll) track.seekPreRollNs = uintOf(data, preRoll);
  const video = one(parts, ID_VIDEO);
  if (video) {
    const fields = listElements(data, video.payload, video.end);
    track.width = uintOf(data, one(fields, ID_PIXEL_WIDTH) as EbmlElement);
    track.height = uintOf(data, one(fields, ID_PIXEL_HEIGHT) as EbmlElement);
  }
  const audio = one(parts, ID_AUDIO);
  if (audio) {
    const fields = listElements(data, audio.payload, audio.end);
    track.samplingFrequency = floatOf(data, one(fields, ID_SAMPLING_FREQUENCY) as EbmlElement);
    track.channels = uintOf(data, one(fields, ID_CHANNELS) as EbmlElement);
  }
  return track;
}

function parseBlockBody(data: Uint8Array, element: EbmlElement, clusterTimecode: number, clusterStart: number): WalkedBlock {
  const { value: track, length } = readVintValue(data, element.payload);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const relative = view.getInt16(element.payload + length);
  const flags = data[element.payload + length + 2];
  if ((flags & 0x06) !== 0) throw new Error('laced blocks are not read by this walker');
  return {
    track,
    timecode: clusterTimecode + relative,
    keyframe: (flags & 0x80) !== 0,
    data: data.slice(element.payload + length + 3, element.end),
    clusterStart,
  };
}

/** Walks a complete WebM/Matroska file whose master elements all have known sizes. */
export function walkWebm(data: Uint8Array): WalkedWebm {
  const top = listElements(data, 0, data.byteLength);
  const header = one(top, ID_EBML);
  const segment = one(top, ID_SEGMENT);
  if (!header || !segment) throw new Error('no EBML header or no Segment');
  const docType = one(listElements(data, header.payload, header.end), ID_DOCTYPE);
  const result: WalkedWebm = {
    docType: docType ? stringOf(data, docType) : '',
    timecodeScale: 1_000_000,
    segmentPayload: segment.payload,
    tracks: [],
    blocks: [],
    cues: [],
    clusterPositions: [],
    seeks: new Map(),
    positions: new Map(),
  };

  for (const element of listElements(data, segment.payload, segment.end)) {
    if (!result.positions.has(element.id)) result.positions.set(element.id, element.start - segment.payload);
    if (element.id === ID_SEEKHEAD) {
      for (const seek of listElements(data, element.payload, element.end)) {
        if (seek.id !== ID_SEEK) continue;
        const fields = listElements(data, seek.payload, seek.end);
        const idElement = one(fields, ID_SEEK_ID) as EbmlElement;
        result.seeks.set(uintOf(data, idElement), uintOf(data, one(fields, ID_SEEK_POSITION) as EbmlElement));
      }
    } else if (element.id === ID_INFO) {
      const fields = listElements(data, element.payload, element.end);
      const scale = one(fields, ID_TIMECODE_SCALE);
      if (scale) result.timecodeScale = uintOf(data, scale);
      const duration = one(fields, ID_DURATION);
      if (duration) result.duration = floatOf(data, duration);
    } else if (element.id === ID_TRACKS) {
      for (const entry of listElements(data, element.payload, element.end)) {
        if (entry.id === ID_TRACK_ENTRY) result.tracks.push(parseTrack(data, entry));
      }
    } else if (element.id === ID_CLUSTER) {
      result.clusterPositions.push(element.start - segment.payload);
      const parts = listElements(data, element.payload, element.end);
      const timecode = uintOf(data, one(parts, ID_CLUSTER_TIMECODE) as EbmlElement);
      for (const part of parts) {
        if (part.id === ID_SIMPLE_BLOCK) {
          result.blocks.push(parseBlockBody(data, part, timecode, element.start - segment.payload));
        } else if (part.id === ID_BLOCK_GROUP) {
          const block = one(listElements(data, part.payload, part.end), ID_BLOCK) as EbmlElement;
          result.blocks.push(parseBlockBody(data, block, timecode, element.start - segment.payload));
        }
      }
    } else if (element.id === ID_CUES) {
      for (const point of listElements(data, element.payload, element.end)) {
        if (point.id !== ID_CUE_POINT) continue;
        const fields = listElements(data, point.payload, point.end);
        const positions = listElements(
          data,
          (one(fields, ID_CUE_TRACK_POSITIONS) as EbmlElement).payload,
          (one(fields, ID_CUE_TRACK_POSITIONS) as EbmlElement).end
        );
        result.cues.push({
          time: uintOf(data, one(fields, ID_CUE_TIME) as EbmlElement),
          track: uintOf(data, one(positions, ID_CUE_TRACK) as EbmlElement),
          clusterPosition: uintOf(data, one(positions, ID_CUE_CLUSTER_POSITION) as EbmlElement),
        });
      }
    }
  }
  return result;
}

export const WEBM_IDS = { CLUSTER: ID_CLUSTER, CUES: ID_CUES, INFO: ID_INFO, TRACKS: ID_TRACKS } as const;
