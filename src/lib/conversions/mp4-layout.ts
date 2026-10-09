import fs from 'node:fs';
import type { InputStream } from './media-ffprobe';

/**
 * Which streams an MP4 or MOV holds, read from its movie box without a media prober. A conversion plans its stream
 * mapping from this list, and a prober process costs about as much as encoding a short clip. The reader answers only
 * for the shapes it can describe exactly: a plain movie of H.264 pictures and AAC, MP3, AC-3 or Opus sound, with no
 * fragments, chapters, cover art, subtitles or data tracks. Everything else (and anything malformed or truncated)
 * answers `null`, and the caller asks ffprobe instead; the reader never guesses.
 */

/** The stream facts a mapping plan reads. */
export type LayoutStream = Pick<
  InputStream,
  'index' | 'type' | 'codecName' | 'attachedPicture' | 'title' | 'language' | 'colorTransfer' | 'width' | 'height'
>;

export interface Mp4Layout {
  streams: LayoutStream[];
  /** Length of the movie in seconds as its header states it; absent when the header gives none. */
  durationSec?: number;
}

/** Signals a shape this reader does not describe; the entry point turns it into a null answer. */
class Unsupported extends Error {}

function unsupported(): never {
  throw new Unsupported();
}

const BOX_HEADER_BYTES = 8;
const BOX_LARGE_HEADER_BYTES = 16;
const FULL_BOX_PREFIX_BYTES = 4;
/** Boxes examined at the top level, tracks in a movie and children of one box before giving up. */
const MAX_TOP_LEVEL_BOXES = 256;
const MAX_TRACKS = 64;
const MAX_CHILD_BOXES = 4096;
/** A movie box larger than this is not read; real ones are kilobytes to a few megabytes. */
const MAX_MOOV_BYTES = 16 * 1024 * 1024;

const ACCEPTED_BRANDS: ReadonlySet<string> = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', 'qt  ',
]);
/** Top-level boxes of a movie with its samples in one `mdat`. */
const TOP_LEVEL_BOXES: ReadonlySet<string> = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']);
const MOOV_CHILDREN: ReadonlySet<string> = new Set(['mvhd', 'trak', 'udta', 'iods', 'free', 'skip', 'wide']);
const TRAK_CHILDREN: ReadonlySet<string> = new Set(['tkhd', 'edts', 'mdia']);
/** Tags that make a file carry chapters or cover art, wherever they sit in the movie box. */
const CHAPTER_AND_COVER_TAGS = [Buffer.from('chpl', 'latin1'), Buffer.from('covr', 'latin1')];

interface Box {
  type: string;
  /** First byte of the content (after the header). */
  body: number;
  end: number;
}

/** The boxes in `buf[from, to)`; any box that does not fit its parent makes the whole file unsupported. */
function boxesIn(buf: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let offset = from;
  while (offset < to) {
    if (boxes.length >= MAX_CHILD_BOXES || offset + BOX_HEADER_BYTES > to) unsupported();
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerBytes = BOX_HEADER_BYTES;
    if (size === 1) {
      if (offset + BOX_LARGE_HEADER_BYTES > to || buf.readUInt32BE(offset + 8) !== 0) unsupported();
      size = buf.readUInt32BE(offset + 12);
      headerBytes = BOX_LARGE_HEADER_BYTES;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < headerBytes || offset + size > to) unsupported();
    boxes.push({ type, body: offset + headerBytes, end: offset + size });
    offset += size;
  }
  return boxes;
}

function child(boxes: readonly Box[], type: string): Box | undefined {
  const found = boxes.filter((box) => box.type === type);
  if (found.length > 1) unsupported();
  return found[0];
}

function mustHave(box: Box | undefined): Box {
  return box ?? unsupported();
}

/** Requires `bytes` bytes at `offset` to lie inside the box that ends at `end`. */
function need(offset: number, bytes: number, end: number): void {
  if (offset < 0 || bytes < 0 || offset + bytes > end) unsupported();
}

// --- H.264 sequence parameter set -------------------------------------------------------------------------------

/** Reads bits MSB first from RBSP bytes (emulation prevention bytes already removed). */
class BitReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    const byte = this.bytes[this.position >> 3];
    if (byte === undefined) unsupported();
    const value = (byte >> (7 - (this.position & 7))) & 1;
    this.position += 1;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bit();
    return value;
  }

  /** Unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros += 1;
      if (zeros > 32) unsupported();
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  /** Signed Exp-Golomb. */
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

const NAL_TYPE_SPS = 7;
const NAL_TYPE_MASK = 0x1f;
/** Profiles whose parameter set states a chroma format, bit depths and optional scaling lists. */
const HIGH_PROFILES: ReadonlySet<number> = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
const CHROMA_444 = 3;
const SCALING_LISTS_DEFAULT = 8;
const SCALING_LISTS_444 = 12;
const SCALING_LIST_SMALL = 16;
const SCALING_LIST_LARGE = 64;
const SCALING_MODULUS = 256;
const EXTENDED_SAR = 255;
const POC_TYPE_CYCLE = 1;
const POC_TYPE_LSB = 0;

function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

function skipScalingList(reader: BitReader, size: number): void {
  let last = SCALING_LISTS_DEFAULT;
  let next = SCALING_LISTS_DEFAULT;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      next = (last + reader.se() + SCALING_MODULUS) % SCALING_MODULUS;
    }
    if (next !== 0) last = next;
  }
}

/** The transfer characteristic code the sequence parameter set states in its video usability information, if any. */
function spsTransferCode(nal: Uint8Array): number | undefined {
  if (nal.length < 4 || (nal[0] & NAL_TYPE_MASK) !== NAL_TYPE_SPS) unsupported();
  const reader = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profile = reader.bits(8);
  reader.bits(16); // constraint flags and level
  reader.ue(); // seq_parameter_set_id
  if (HIGH_PROFILES.has(profile)) {
    const chroma = reader.ue();
    if (chroma === CHROMA_444) reader.bit();
    reader.ue(); // bit_depth_luma_minus8
    reader.ue(); // bit_depth_chroma_minus8
    reader.bit(); // qpprime_y_zero_transform_bypass_flag
    if (reader.bit() === 1) {
      const lists = chroma === CHROMA_444 ? SCALING_LISTS_444 : SCALING_LISTS_DEFAULT;
      for (let i = 0; i < lists; i++) {
        if (reader.bit() === 1) skipScalingList(reader, i < 6 ? SCALING_LIST_SMALL : SCALING_LIST_LARGE);
      }
    }
  }
  reader.ue(); // log2_max_frame_num_minus4
  const pocType = reader.ue();
  if (pocType === POC_TYPE_LSB) {
    reader.ue();
  } else if (pocType === POC_TYPE_CYCLE) {
    reader.bit();
    reader.se();
    reader.se();
    const cycle = reader.ue();
    if (cycle > 255) unsupported();
    for (let i = 0; i < cycle; i++) reader.se();
  }
  reader.ue(); // max_num_ref_frames
  reader.bit(); // gaps_in_frame_num_value_allowed_flag
  reader.ue(); // pic_width_in_mbs_minus1
  reader.ue(); // pic_height_in_map_units_minus1
  if (reader.bit() === 0) reader.bit(); // frame_mbs_only_flag, mb_adaptive_frame_field_flag
  reader.bit(); // direct_8x8_inference_flag
  if (reader.bit() === 1) {
    for (let i = 0; i < 4; i++) reader.ue(); // frame cropping offsets
  }
  if (reader.bit() === 0) return undefined; // no video usability information
  if (reader.bit() === 1 && reader.bits(8) === EXTENDED_SAR) reader.bits(32); // aspect_ratio_info
  if (reader.bit() === 1) reader.bit(); // overscan
  if (reader.bit() === 0) return undefined; // no video signal type
  reader.bits(3); // video_format
  reader.bit(); // video_full_range_flag
  if (reader.bit() === 0) return undefined; // no colour description
  reader.bits(8); // colour_primaries
  return reader.bits(8);
}

// --- colour --------------------------------------------------------------------------------------------------

/** Names ffprobe gives the transfer characteristic codes it knows (ISO/IEC 23091-2 Table 3). */
const TRANSFER_NAMES: Readonly<Record<number, string>> = {
  1: 'bt709',
  4: 'gamma22',
  5: 'gamma28',
  6: 'smpte170m',
  7: 'smpte240m',
  8: 'linear',
  9: 'log100',
  10: 'log316',
  11: 'iec61966-2-4',
  12: 'bt1361e',
  13: 'iec61966-2-1',
  14: 'bt2020-10',
  15: 'bt2020-12',
  16: 'smpte2084',
  17: 'smpte428',
  18: 'arib-std-b67',
};
const TRANSFER_UNSPECIFIED = 2;

function transferName(code: number): string | undefined {
  if (code === TRANSFER_UNSPECIFIED) return undefined;
  return Object.hasOwn(TRANSFER_NAMES, code) ? TRANSFER_NAMES[code] : unsupported();
}

/** The `colr` box with on-screen colours (`nclx`) of a picture and its transfer code; null when the picture has none. */
function colourBoxTransfer(buf: Buffer, entry: Box[]): { code: number } | null {
  const colours = entry.filter((box) => box.type === 'colr');
  const nclx = colours.filter((box) => buf.toString('latin1', box.body, box.body + 4) === 'nclx');
  // `nclc` (QuickTime) is read differently by the prober; two on-screen descriptions are ambiguous.
  if (nclx.length > 1 || colours.some((box) => buf.toString('latin1', box.body, box.body + 4) === 'nclc')) unsupported();
  if (nclx.length === 0) return null;
  need(nclx[0].body, 11, nclx[0].end);
  return { code: buf.readUInt16BE(nclx[0].body + 6) };
}

// --- sample entries --------------------------------------------------------------------------------------------

const VIDEO_ENTRY_BYTES = 78;
/** Width and height (16 bits each) sit after the reserved fields of a visual sample entry. */
const VIDEO_ENTRY_SIZE_OFFSET = 24;
const AUDIO_ENTRY_BYTES: Readonly<Record<number, number>> = { 0: 28, 1: 44, 2: 64 };
const AUDIO_VERSION_OFFSET = 8;
const AVCC_SPS_OFFSET = 6;
const AVCC_SPS_COUNT_MASK = 0x1f;
const ES_DESCRIPTOR = 0x03;
const DECODER_CONFIG = 0x04;
const DECODER_SPECIFIC_INFO = 0x05;
const OBJECT_TYPE_AAC = 0x40;
const OBJECT_TYPES_MP3: ReadonlySet<number> = new Set([0x69, 0x6b]);
/** Audio object types ffprobe calls `aac` (Main, LC, SSR, LTP, SBR, scalable and PS variants). */
const AAC_OBJECT_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 17, 19, 20, 21, 22, 23, 29]);
const AOT_SHIFT = 3;
const AOT_ESCAPE = 31;
const ES_FLAG_STREAM_DEPENDENCE = 0x80;
const ES_FLAG_URL = 0x40;
const ES_FLAG_OCR = 0x20;
const DESCRIPTOR_CONTINUATION = 0x80;
const DESCRIPTOR_LENGTH_MASK = 0x7f;
const DESCRIPTOR_LENGTH_BYTES_MAX = 4;
const DECODER_CONFIG_FIXED_BYTES = 13;

/** Reads a descriptor's tag and (expandable) length; returns where its content starts and ends. */
function descriptorAt(buf: Buffer, offset: number, end: number): { tag: number; body: number; end: number } {
  need(offset, 2, end);
  const tag = buf[offset];
  let position = offset + 1;
  let length = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH_BYTES_MAX; i++) {
    need(position, 1, end);
    const byte = buf[position];
    position += 1;
    length = length * 128 + (byte & DESCRIPTOR_LENGTH_MASK);
    if ((byte & DESCRIPTOR_CONTINUATION) === 0) break;
  }
  need(position, length, end);
  return { tag, body: position, end: position + length };
}

/** `aac` or `mp3` from an `esds` box: the object type of its decoder configuration, and for AAC its audio object type. */
function mpeg4AudioCodec(buf: Buffer, esds: Box): string {
  need(esds.body, FULL_BOX_PREFIX_BYTES, esds.end);
  const es = descriptorAt(buf, esds.body + FULL_BOX_PREFIX_BYTES, esds.end);
  if (es.tag !== ES_DESCRIPTOR) unsupported();
  need(es.body, 3, es.end);
  const flags = buf[es.body + 2];
  let position = es.body + 3;
  if (flags & ES_FLAG_STREAM_DEPENDENCE) position += 2;
  if (flags & ES_FLAG_URL) {
    need(position, 1, es.end);
    position += 1 + buf[position];
  }
  if (flags & ES_FLAG_OCR) position += 2;
  const config = descriptorAt(buf, position, es.end);
  if (config.tag !== DECODER_CONFIG) unsupported();
  need(config.body, DECODER_CONFIG_FIXED_BYTES, config.end);
  const objectType = buf[config.body];
  if (OBJECT_TYPES_MP3.has(objectType)) return 'mp3';
  if (objectType !== OBJECT_TYPE_AAC) unsupported();
  const info = descriptorAt(buf, config.body + DECODER_CONFIG_FIXED_BYTES, config.end);
  if (info.tag !== DECODER_SPECIFIC_INFO || info.end <= info.body) unsupported();
  const audioObjectType = buf[info.body] >> AOT_SHIFT;
  if (audioObjectType === AOT_ESCAPE || !AAC_OBJECT_TYPES.has(audioObjectType)) unsupported();
  return 'aac';
}

function findEsds(buf: Buffer, entry: Box[]): Box {
  const direct = entry.find((box) => box.type === 'esds');
  if (direct) return direct;
  // QuickTime sound descriptions keep it inside a `wave` box.
  const wave = child(entry, 'wave');
  return mustHave(wave ? boxesIn(buf, wave.body, wave.end).find((box) => box.type === 'esds') : undefined);
}

interface EntryFacts {
  type: 'video' | 'audio';
  codecName: string;
  colorTransfer?: string;
  width?: number;
  height?: number;
}

function videoEntry(buf: Buffer, fourcc: string, entryBody: number, entryEnd: number): EntryFacts {
  if (fourcc !== 'avc1' && fourcc !== 'avc3') unsupported();
  need(entryBody, VIDEO_ENTRY_BYTES, entryEnd);
  const children = boxesIn(buf, entryBody + VIDEO_ENTRY_BYTES, entryEnd);
  const avcC = mustHave(child(children, 'avcC'));
  need(avcC.body, AVCC_SPS_OFFSET + 2, avcC.end);
  if (buf[avcC.body] !== 1 || (buf[avcC.body + 5] & AVCC_SPS_COUNT_MASK) !== 1) unsupported();
  const spsLength = buf.readUInt16BE(avcC.body + AVCC_SPS_OFFSET);
  need(avcC.body + AVCC_SPS_OFFSET + 2, spsLength, avcC.end);
  const streamStated = spsTransferCode(buf.subarray(avcC.body + AVCC_SPS_OFFSET + 2, avcC.body + AVCC_SPS_OFFSET + 2 + spsLength));
  // A stream that marks its transfer unspecified makes no statement.
  const streamCode = streamStated === TRANSFER_UNSPECIFIED ? undefined : streamStated;
  const container = colourBoxTransfer(buf, children);
  // The prober settles a container tag that the stream does not repeat differently by release: ffprobe 7 and later
  // take the container's tag when the stream states none and report no transfer when the two differ, while 6.1
  // reports the stream's statement in both cases (and nothing when the stream states none). Only the shapes every
  // release answers alike are read here: a stream alone, or a container and a stream that agree.
  let code: number | undefined;
  if (container === null) code = streamCode;
  else if (streamCode === container.code || (streamCode === undefined && container.code === TRANSFER_UNSPECIFIED)) code = streamCode;
  else unsupported();
  return {
    type: 'video',
    codecName: 'h264',
    colorTransfer: code === undefined ? undefined : transferName(code),
    width: buf.readUInt16BE(entryBody + VIDEO_ENTRY_SIZE_OFFSET),
    height: buf.readUInt16BE(entryBody + VIDEO_ENTRY_SIZE_OFFSET + 2),
  };
}

function audioEntry(buf: Buffer, fourcc: string, entryBody: number, entryEnd: number): EntryFacts {
  need(entryBody, AUDIO_ENTRY_BYTES[0], entryEnd);
  const version = buf.readUInt16BE(entryBody + AUDIO_VERSION_OFFSET);
  if (!Object.hasOwn(AUDIO_ENTRY_BYTES, version)) unsupported();
  need(entryBody, AUDIO_ENTRY_BYTES[version], entryEnd);
  const children = boxesIn(buf, entryBody + AUDIO_ENTRY_BYTES[version], entryEnd);
  if (fourcc === 'mp4a') return { type: 'audio', codecName: mpeg4AudioCodec(buf, findEsds(buf, children)) };
  if (fourcc === 'ac-3') return { type: 'audio', codecName: 'ac3' };
  if (fourcc === 'Opus') return { type: 'audio', codecName: 'opus' };
  return unsupported();
}

// --- tracks ----------------------------------------------------------------------------------------------------

const MDHD_LANGUAGE_OFFSET: Readonly<Record<number, number>> = { 0: 20, 1: 32 };
const MIN_PACKED_LANGUAGE = 0x400;
const LANGUAGE_UNSPECIFIED_PACKED = 0x7fff;
const LANGUAGE_CHAR_BITS = 5;
const LANGUAGE_CHAR_MASK = 0x1f;
const LANGUAGE_CHAR_BASE = 0x60;

/** The codes QuickTime writers leave when a track states no language (the legacy zero, and all ones); the prober reports none. */
const LANGUAGES_NOT_STATED: ReadonlySet<number> = new Set([0, LANGUAGE_UNSPECIFIED_PACKED]);

/**
 * The ISO 639-2 code packed into a media header, or undefined when the track states none. The other legacy
 * numbering is mapped through a table of the prober's, which this reader does not repeat.
 */
function packedLanguage(code: number): string | undefined {
  if (LANGUAGES_NOT_STATED.has(code)) return undefined;
  if (code < MIN_PACKED_LANGUAGE) unsupported();
  const letters = [10, 5, 0].map((shift) => ((code >> shift) & LANGUAGE_CHAR_MASK) + LANGUAGE_CHAR_BASE);
  if (letters.some((letter) => letter < 0x61 || letter > 0x7a)) unsupported();
  return String.fromCharCode(...letters);
}

/** Sample tables every track of a readable file has: times, sizes, chunk map and chunk offsets with at least one sample. */
function assertSampleTables(buf: Buffer, stbl: Box[]): void {
  const stts = mustHave(child(stbl, 'stts'));
  need(stts.body, 8, stts.end);
  const entries = buf.readUInt32BE(stts.body + 4);
  need(stts.body + 8, entries * 8, stts.end);
  let samples = 0;
  for (let i = 0; i < entries; i++) samples += buf.readUInt32BE(stts.body + 8 + i * 8);
  if (samples === 0) unsupported();

  const stsz = mustHave(child(stbl, 'stsz'));
  need(stsz.body, 12, stsz.end);
  if (buf.readUInt32BE(stsz.body + 8) === 0) unsupported();

  const stsc = mustHave(child(stbl, 'stsc'));
  need(stsc.body, 8, stsc.end);
  if (buf.readUInt32BE(stsc.body + 4) === 0) unsupported();
  const offsets = child(stbl, 'stco') ?? mustHave(child(stbl, 'co64'));
  need(offsets.body, 8, offsets.end);
  if (buf.readUInt32BE(offsets.body + 4) === 0) unsupported();
}

function readTrack(buf: Buffer, trak: Box, index: number): LayoutStream {
  const parts = boxesIn(buf, trak.body, trak.end);
  if (parts.some((box) => !TRAK_CHILDREN.has(box.type))) unsupported();
  mustHave(child(parts, 'tkhd'));
  const mdiaBox = mustHave(child(parts, 'mdia'));
  const mdia = boxesIn(buf, mdiaBox.body, mdiaBox.end);

  const mdhd = mustHave(child(mdia, 'mdhd'));
  need(mdhd.body, 1, mdhd.end);
  const version = buf[mdhd.body];
  if (!Object.hasOwn(MDHD_LANGUAGE_OFFSET, version)) unsupported();
  need(mdhd.body, MDHD_LANGUAGE_OFFSET[version] + 2, mdhd.end);
  const language = packedLanguage(buf.readUInt16BE(mdhd.body + MDHD_LANGUAGE_OFFSET[version]));

  const hdlr = mustHave(child(mdia, 'hdlr'));
  need(hdlr.body, 12, hdlr.end);
  const handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
  if (handler !== 'vide' && handler !== 'soun') unsupported();

  const minfBox = mustHave(child(mdia, 'minf'));
  const minf = boxesIn(buf, minfBox.body, minfBox.end);
  const stblBox = mustHave(child(minf, 'stbl'));
  const stbl = boxesIn(buf, stblBox.body, stblBox.end);
  assertSampleTables(buf, stbl);

  const stsd = mustHave(child(stbl, 'stsd'));
  need(stsd.body, 16, stsd.end);
  if (buf.readUInt32BE(stsd.body + 4) !== 1) unsupported();
  const entryStart = stsd.body + 8;
  const entrySize = buf.readUInt32BE(entryStart);
  const fourcc = buf.toString('latin1', entryStart + 4, entryStart + 8);
  need(entryStart, entrySize, stsd.end);
  const entryEnd = entryStart + entrySize;
  const facts =
    handler === 'vide'
      ? videoEntry(buf, fourcc, entryStart + BOX_HEADER_BYTES, entryEnd)
      : audioEntry(buf, fourcc, entryStart + BOX_HEADER_BYTES, entryEnd);
  return {
    index,
    type: facts.type,
    codecName: facts.codecName,
    attachedPicture: false,
    ...(language === undefined ? {} : { language }),
    ...(facts.colorTransfer === undefined ? {} : { colorTransfer: facts.colorTransfer }),
    ...(facts.width === undefined ? {} : { width: facts.width, height: facts.height }),
  };
}

const MVHD_FIELDS: Readonly<Record<number, { timescale: number; duration: number; wide: boolean }>> = {
  0: { timescale: 12, duration: 16, wide: false },
  1: { timescale: 20, duration: 24, wide: true },
};

/** Duration in seconds from a movie header, or undefined when it states none that can be used. */
function movieDuration(buf: Buffer, mvhd: Box): number | undefined {
  need(mvhd.body, 1, mvhd.end);
  const version = buf[mvhd.body];
  if (!Object.hasOwn(MVHD_FIELDS, version)) unsupported();
  const fields = MVHD_FIELDS[version];
  need(mvhd.body, fields.duration + (fields.wide ? 8 : 4), mvhd.end);
  const timescale = buf.readUInt32BE(mvhd.body + fields.timescale);
  const ticks = fields.wide ? Number(buf.readBigUInt64BE(mvhd.body + fields.duration)) : buf.readUInt32BE(mvhd.body + fields.duration);
  const seconds = ticks / timescale;
  return timescale > 0 && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** The streams of a movie box held in `moov` (its content, header excluded). */
export function parseMoovLayout(moov: Buffer): Mp4Layout {
  if (CHAPTER_AND_COVER_TAGS.some((tag) => moov.includes(tag))) unsupported();
  const parts = boxesIn(moov, 0, moov.length);
  if (parts.some((box) => !MOOV_CHILDREN.has(box.type))) unsupported();
  const durationSec = movieDuration(moov, mustHave(child(parts, 'mvhd')));
  const tracks = parts.filter((box) => box.type === 'trak');
  if (tracks.length === 0 || tracks.length > MAX_TRACKS) unsupported();
  const layout: Mp4Layout = { streams: tracks.map((trak, index) => readTrack(moov, trak, index)) };
  return durationSec === undefined ? layout : { ...layout, durationSec };
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  if (fs.readSync(fd, out, 0, length, offset) !== length) unsupported();
  return out;
}

/** Walks the top-level boxes of the file and returns the content of its single `moov`. */
function readMoov(fd: number, fileSize: number): Buffer {
  let offset = 0;
  let moov: Buffer | undefined;
  for (let count = 0; offset < fileSize; count++) {
    if (count >= MAX_TOP_LEVEL_BOXES || offset + BOX_HEADER_BYTES > fileSize) unsupported();
    const head = readAt(fd, offset, Math.min(BOX_LARGE_HEADER_BYTES, fileSize - offset));
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerBytes = BOX_HEADER_BYTES;
    if (size === 1) {
      if (head.length < BOX_LARGE_HEADER_BYTES || head.readUInt32BE(8) !== 0) unsupported();
      size = head.readUInt32BE(12);
      headerBytes = BOX_LARGE_HEADER_BYTES;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerBytes || offset + size > fileSize || !TOP_LEVEL_BOXES.has(type)) unsupported();
    if (count === 0) {
      if (type !== 'ftyp' || size < BOX_HEADER_BYTES + 4) unsupported();
      if (!ACCEPTED_BRANDS.has(readAt(fd, offset + headerBytes, 4).toString('latin1'))) unsupported();
    }
    if (type === 'moov') {
      if (moov !== undefined || size - headerBytes > MAX_MOOV_BYTES) unsupported();
      moov = readAt(fd, offset + headerBytes, size - headerBytes);
    }
    offset += size;
  }
  return moov ?? unsupported();
}

/**
 * The streams of the MP4 or MOV at `filePath`, or null when this reader cannot describe the file exactly (another
 * container, another codec, fragments, chapters, cover art, subtitles, data tracks, or a damaged or cut-off file).
 */
export function readMp4Layout(filePath: string): Mp4Layout | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    return parseMoovLayout(readMoov(fd, fs.fstatSync(fd).size));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
