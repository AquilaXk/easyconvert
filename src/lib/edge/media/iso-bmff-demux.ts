/**
 * Strict ISO/IEC 14496-12 (ISO base media file format) demuxer for the edge WebCodecs worker.
 *
 * Everything it returns is read from the file: sample sizes and offsets from stsz/stsc/stco/co64, decode
 * times from stts, composition offsets from ctts, sync samples from stss, the edit list from elst, frame size
 * and the WebCodecs codec string from the sample entry (avcC, hvcC, vpcC, av1C, esds). A file that lacks a
 * table, has tables that disagree, exceeds a limit below, or uses a feature the edge cannot honour (fragments,
 * several sample descriptions, display transforms, edits that cut media) throws EdgeUnsupportedError, so the
 * server tier converts it. Nothing is defaulted or guessed.
 *
 * References: ISO/IEC 14496-12 (boxes, sample tables, edit lists), ISO/IEC 14496-14 (esds),
 * ISO/IEC 14496-15 (avcC, hvcC and their codec strings), ISO/IEC 14496-3 (AudioSpecificConfig),
 * VP Codec ISO Media File Format Binding (vpcC), AV1 Codec ISO Media File Format Binding (av1C).
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import { AAC_LC_CODEC, OTI_MPEG4_AUDIO, parseAacLcConfig } from './aac';
import type { DemuxedMediaSample, DemuxedTrackInfo } from './media-types';

/** Samples per track. 100 MB of 64 kbit/s audio is under 700,000 AAC frames. */
export const MP4_MAX_SAMPLES_PER_TRACK = 1_000_000;
/** Sibling boxes read at one level of the box tree. */
export const MP4_MAX_BOXES_PER_LEVEL = 4_096;
export const MP4_MAX_TRACKS = 64;
export const MP4_MAX_EDIT_LIST_ENTRIES = 16;
/** Largest decoder configuration record (avcC, hvcC, av1C, AudioSpecificConfig) copied out of a file. */
export const MP4_MAX_CONFIG_BYTES = 64 * 1024;
/** Descriptors read inside one esds box. */
export const MP4_MAX_ESDS_DESCRIPTORS = 32;

const MICROS_PER_SECOND = 1_000_000;
const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
const FULL_BOX_HEADER_BYTES = 4;
const LARGE_SIZE_MARKER = 1;
const SIZE_TO_END_MARKER = 0;
const VISUAL_ENTRY_FIXED_BYTES = 78;
const AUDIO_ENTRY_FIXED_BYTES = 28;
/** Offsets inside the fixed part of a sample entry, after the 8-byte box header (ISO/IEC 14496-12 12.1, 12.2). */
const VISUAL_ENTRY_WIDTH_OFFSET = 24;
const AUDIO_ENTRY_VERSION_OFFSET = 8;
const AUDIO_ENTRY_CHANNELS_OFFSET = 16;
const AUDIO_ENTRY_RATE_OFFSET = 24;
const FIXED_POINT_SHIFT = 16;
const TKHD_FLAG_ENABLED = 0x1;
const EDIT_RATE_ONE = 1;
const EMPTY_EDIT_MEDIA_TIME = -1;
const HEX_RADIX = 16;

const IDENTITY_MATRIX: readonly number[] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const MATRIX_ENTRIES = IDENTITY_MATRIX.length;

const OTI_MPEG1_AUDIO = 0x6b;
const OTI_MPEG2_AUDIO = 0x69;
const ES_DESCRIPTOR_TAG = 0x03;
const DECODER_CONFIG_DESCRIPTOR_TAG = 0x04;
const DECODER_SPECIFIC_INFO_TAG = 0x05;
const ES_FLAG_STREAM_DEPENDENCE = 0x80;
const ES_FLAG_URL = 0x40;
const ES_FLAG_OCR = 0x20;
const DESCRIPTOR_LENGTH_BYTES_MAX = 4;
const DESCRIPTOR_LENGTH_CONTINUE = 0x80;
const DESCRIPTOR_LENGTH_MASK = 0x7f;

const HEVC_CONSTRAINT_BYTES = 6;
const HEVC_PROFILE_SPACE_LETTERS: readonly string[] = ['', 'A', 'B', 'C'];
const HVCC_MIN_BYTES = 13;
const AVCC_MIN_BYTES = 7;
const VPCC_VERSION = 1;
const VPCC_MIN_BYTES = 12;
const AV1C_MARKER_AND_VERSION = 0x81;
const AV1C_MIN_BYTES = 4;

function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`MP4: ${message}; the server engine converts this file.`);
}

function hex2(value: number): string {
  return value.toString(HEX_RADIX).padStart(2, '0');
}

function dec2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Bounds-checked big-endian reader; every read past `end` throws. */
class Cursor {
  constructor(
    private readonly view: DataView,
    public pos: number,
    private readonly end: number,
    private readonly what: string
  ) {}

  get remaining(): number {
    return this.end - this.pos;
  }

  private take(bytes: number): number {
    if (bytes > this.end - this.pos) throw refuse(`${this.what} is truncated`);
    const at = this.pos;
    this.pos += bytes;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2));
  }

  i16(): number {
    return this.view.getInt16(this.take(2));
  }

  u32(): number {
    return this.view.getUint32(this.take(4));
  }

  i32(): number {
    return this.view.getInt32(this.take(4));
  }

  u64(): number {
    const value = this.view.getBigUint64(this.take(8));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse(`${this.what} holds a 64-bit value beyond 2^53`);
    return Number(value);
  }

  i64(): number {
    const value = this.view.getBigInt64(this.take(8));
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw refuse(`${this.what} holds a 64-bit value beyond 2^53`);
    }
    return Number(value);
  }

  skip(bytes: number): void {
    this.take(bytes);
  }
}

interface Mp4Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset of the first payload byte. */
  payload: number;
  /** One past the last byte. */
  end: number;
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function isZeroFilled(view: DataView, start: number, end: number): boolean {
  for (let offset = start; offset < end; offset++) {
    if (view.getUint8(offset) !== 0) return false;
  }
  return true;
}

/** The sibling boxes in [start, end). A box that would run past `end` throws. */
function listBoxes(view: DataView, start: number, end: number, what: string): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (boxes.length >= MP4_MAX_BOXES_PER_LEVEL) throw refuse(`${what} holds more than ${MP4_MAX_BOXES_PER_LEVEL} boxes`);
    if (end - offset < BOX_HEADER_BYTES) {
      // QuickTime files may end in a zero terminator shorter than a box header.
      if (isZeroFilled(view, offset, end)) break;
      throw refuse(`${what} ends inside a box header`);
    }
    let size = view.getUint32(offset);
    const type = fourcc(view, offset + 4);
    let headerBytes = BOX_HEADER_BYTES;
    if (size === LARGE_SIZE_MARKER) {
      if (end - offset < LARGE_BOX_HEADER_BYTES) throw refuse(`${what} ends inside a 64-bit box header`);
      const large = view.getBigUint64(offset + BOX_HEADER_BYTES);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse(`box ${type} overruns its parent`);
      size = Number(large);
      headerBytes = LARGE_BOX_HEADER_BYTES;
    } else if (size === SIZE_TO_END_MARKER) {
      size = end - offset;
    }
    if (size < headerBytes || size > end - offset) throw refuse(`box ${type} in ${what} overruns its parent`);
    boxes.push({ type, start: offset, payload: offset + headerBytes, end: offset + size });
    offset += size;
  }
  return boxes;
}

function children(view: DataView, parent: Mp4Box): Mp4Box[] {
  return listBoxes(view, parent.payload, parent.end, parent.type);
}

/** The single child of `type`; a second one is as wrong as none. */
function optionalChild(boxes: Mp4Box[], type: string): Mp4Box | undefined {
  const found = boxes.filter((box) => box.type === type);
  if (found.length > 1) throw refuse(`more than one ${type} box`);
  return found[0];
}

function requiredChild(boxes: Mp4Box[], type: string, what: string): Mp4Box {
  const found = optionalChild(boxes, type);
  if (!found) throw refuse(`${what} has no ${type} box`);
  return found;
}

/** A cursor over the payload of a full box, past its version and flags; returns them with the cursor. */
function openFullBox(view: DataView, box: Mp4Box): { cursor: Cursor; version: number; flags: number } {
  const cursor = new Cursor(view, box.payload, box.end, `${box.type} box`);
  const versionAndFlags = cursor.u32();
  return { cursor, version: versionAndFlags >>> 24, flags: versionAndFlags & 0xffffff };
}

// ---------------------------------------------------------------------------------------------------
// Decoder configuration records and codec strings
// ---------------------------------------------------------------------------------------------------

function copyBytes(view: DataView, start: number, end: number, what: string): Uint8Array {
  if (end - start > MP4_MAX_CONFIG_BYTES) throw refuse(`${what} is larger than ${MP4_MAX_CONFIG_BYTES} bytes`);
  return new Uint8Array(view.buffer, view.byteOffset + start, end - start).slice();
}

interface VideoConfig {
  codec: string;
  description?: Uint8Array;
}

function avcConfig(view: DataView, entryType: string, config: Mp4Box): VideoConfig {
  const record = copyBytes(view, config.payload, config.end, 'avcC');
  if (record.byteLength < AVCC_MIN_BYTES || record[0] !== 1) throw refuse('avcC is not a version 1 record');
  // ISO/IEC 14496-15 5.3.3.1: profile_idc, profile_compatibility and level_idc follow configurationVersion
  return { codec: `${entryType}.${hex2(record[1])}${hex2(record[2])}${hex2(record[3])}`, description: record };
}

function hevcConfig(view: DataView, entryType: string, config: Mp4Box): VideoConfig {
  const record = copyBytes(view, config.payload, config.end, 'hvcC');
  if (record.byteLength < HVCC_MIN_BYTES || record[0] !== 1) throw refuse('hvcC is not a version 1 record');
  // ISO/IEC 14496-15 E.3: profile space and idc, bit-reversed compatibility flags, tier and level, constraints
  const profileSpace = HEVC_PROFILE_SPACE_LETTERS[record[1] >>> 6];
  const profileIdc = record[1] & 0x1f;
  const tier = (record[1] & 0x20) === 0 ? 'L' : 'H';
  const compatibility = ((record[2] << 24) | (record[3] << 16) | (record[4] << 8) | record[5]) >>> 0;
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (((compatibility >>> bit) & 1) === 1) reversed = (reversed | (1 << (31 - bit))) >>> 0;
  }
  const constraints = Array.from(record.subarray(6, 6 + HEVC_CONSTRAINT_BYTES));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const parts = [
    `${entryType}.${profileSpace}${profileIdc}`,
    reversed.toString(HEX_RADIX),
    `${tier}${record[12]}`,
    ...constraints.map((byte) => byte.toString(HEX_RADIX).toUpperCase()),
  ];
  return { codec: parts.join('.'), description: record };
}

function vp9Config(view: DataView, config: Mp4Box): VideoConfig {
  const { cursor, version } = openFullBox(view, config);
  if (version !== VPCC_VERSION || cursor.remaining < VPCC_MIN_BYTES - FULL_BOX_HEADER_BYTES) {
    throw refuse('vpcC is not a version 1 record');
  }
  const profile = cursor.u8();
  const level = cursor.u8();
  const packed = cursor.u8();
  const primaries = cursor.u8();
  const transfer = cursor.u8();
  const matrix = cursor.u8();
  // VP Codec ISO Media File Format Binding 2.2: bitDepth(4) chromaSubsampling(3) videoFullRangeFlag(1)
  const fields = [profile, level, packed >>> 4, (packed >>> 1) & 7, primaries, transfer, matrix, packed & 1];
  return { codec: `vp09.${fields.map(dec2).join('.')}` };
}

function av1Config(view: DataView, config: Mp4Box): VideoConfig {
  const record = copyBytes(view, config.payload, config.end, 'av1C');
  if (record.byteLength < AV1C_MIN_BYTES || record[0] !== AV1C_MARKER_AND_VERSION) {
    throw refuse('av1C is not a version 1 record');
  }
  // AV1 Codec ISO Media File Format Binding 2.3.3 and the AV1 codecs parameter string
  const profile = record[1] >>> 5;
  const level = record[1] & 0x1f;
  const tier = (record[2] & 0x80) === 0 ? 'M' : 'H';
  const highBitDepth = (record[2] & 0x40) !== 0;
  const twelveBit = (record[2] & 0x20) !== 0;
  let depth = 8;
  if (highBitDepth) depth = twelveBit ? 12 : 10;
  return { codec: `av01.${profile}.${dec2(level)}${tier}.${dec2(depth)}`, description: record };
}

function videoConfig(view: DataView, entryType: string, entryChildren: Mp4Box[]): VideoConfig {
  switch (entryType) {
    case 'avc1':
    case 'avc3':
      return avcConfig(view, entryType, requiredChild(entryChildren, 'avcC', `${entryType} sample entry`));
    case 'hvc1':
    case 'hev1':
      return hevcConfig(view, entryType, requiredChild(entryChildren, 'hvcC', `${entryType} sample entry`));
    case 'vp09':
      return vp9Config(view, requiredChild(entryChildren, 'vpcC', 'vp09 sample entry'));
    case 'vp08':
      return { codec: 'vp8' };
    case 'av01':
      return av1Config(view, requiredChild(entryChildren, 'av1C', 'av01 sample entry'));
    default:
      throw refuse(`unsupported video sample entry "${entryType}"`);
  }
}

/** Reads an MPEG-4 expandable size: seven bits per byte, high bit set while more bytes follow. */
function readDescriptorLength(cursor: Cursor): number {
  let length = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH_BYTES_MAX; i++) {
    const byte = cursor.u8();
    length = (length << 7) | (byte & DESCRIPTOR_LENGTH_MASK);
    if ((byte & DESCRIPTOR_LENGTH_CONTINUE) === 0) return length;
  }
  throw refuse('esds descriptor length is longer than four bytes');
}

interface EsdsInfo {
  objectTypeIndication: number;
  decoderSpecificInfo?: Uint8Array;
}

/** ISO/IEC 14496-14 5.6 and ISO/IEC 14496-1 7.2.6: ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo. */
function parseEsds(view: DataView, esds: Mp4Box): EsdsInfo {
  const { cursor } = openFullBox(view, esds);
  let descriptors = 0;
  const readDescriptor = (parent: Cursor): { tag: number; body: Cursor } => {
    if (++descriptors > MP4_MAX_ESDS_DESCRIPTORS) throw refuse('esds holds too many descriptors');
    const tag = parent.u8();
    const length = readDescriptorLength(parent);
    if (length > parent.remaining) throw refuse('esds descriptor runs past its box');
    const body = new Cursor(view, parent.pos, parent.pos + length, 'esds descriptor');
    parent.skip(length);
    return { tag, body };
  };

  const es = readDescriptor(cursor);
  if (es.tag !== ES_DESCRIPTOR_TAG) throw refuse('esds does not start with an ES_Descriptor');
  es.body.skip(2); // ES_ID
  const flags = es.body.u8();
  if ((flags & ES_FLAG_STREAM_DEPENDENCE) !== 0) es.body.skip(2);
  if ((flags & ES_FLAG_URL) !== 0) es.body.skip(es.body.u8());
  if ((flags & ES_FLAG_OCR) !== 0) es.body.skip(2);

  while (es.body.remaining > 0) {
    const inner = readDescriptor(es.body);
    if (inner.tag !== DECODER_CONFIG_DESCRIPTOR_TAG) continue;
    const objectTypeIndication = inner.body.u8();
    inner.body.skip(1 + 3 + 4 + 4); // streamType, bufferSizeDB, maxBitrate, avgBitrate
    let decoderSpecificInfo: Uint8Array | undefined;
    while (inner.body.remaining > 0) {
      const info = readDescriptor(inner.body);
      if (info.tag === DECODER_SPECIFIC_INFO_TAG) {
        const start = info.body.pos;
        decoderSpecificInfo = copyBytes(view, start, start + info.body.remaining, 'AudioSpecificConfig');
      }
    }
    return { objectTypeIndication, decoderSpecificInfo };
  }
  throw refuse('esds has no DecoderConfigDescriptor');
}

interface AudioConfig {
  codec: string;
  sampleRate: number;
  channels: number;
  description?: Uint8Array;
}

/** ISO/IEC 14496-3 1.6.2.1 AudioSpecificConfig, for AAC-LC only. */
function aacLcConfig(asc: Uint8Array): AudioConfig {
  const config = parseAacLcConfig(asc);
  return { codec: AAC_LC_CODEC, sampleRate: config.sampleRate, channels: config.channels, description: asc };
}

function audioConfig(view: DataView, entryType: string, entryChildren: Mp4Box[], entryChannels: number, entryRate: number): AudioConfig {
  if (entryType !== 'mp4a') throw refuse(`unsupported audio sample entry "${entryType}"`);
  const info = parseEsds(view, requiredChild(entryChildren, 'esds', 'mp4a sample entry'));
  if (info.objectTypeIndication === OTI_MPEG4_AUDIO) {
    if (!info.decoderSpecificInfo) throw refuse('esds carries no AudioSpecificConfig');
    return aacLcConfig(info.decoderSpecificInfo);
  }
  if (info.objectTypeIndication === OTI_MPEG1_AUDIO || info.objectTypeIndication === OTI_MPEG2_AUDIO) {
    if (entryChannels === 0 || entryRate === 0) throw refuse('the MP3 sample entry states no sample rate or channel count');
    return { codec: 'mp3', sampleRate: entryRate, channels: entryChannels };
  }
  throw refuse(`esds object type 0x${hex2(info.objectTypeIndication)} has no WebCodecs decoder configuration`);
}

// ---------------------------------------------------------------------------------------------------
// Sample tables
// ---------------------------------------------------------------------------------------------------

/** entry_count of a table box, checked against what the box can hold before anything is allocated. */
function tableEntryCount(cursor: Cursor, entryBytes: number, type: string): number {
  const count = cursor.u32();
  if (count > MP4_MAX_SAMPLES_PER_TRACK) throw refuse(`${type} claims ${count} entries, beyond the sample limit`);
  if (count * entryBytes > cursor.remaining) throw refuse(`${type} claims ${count} entries but holds fewer`);
  return count;
}

interface SampleTables {
  sampleCount: number;
  sizes: Uint32Array;
  deltas: Uint32Array;
  decodeTimes: Float64Array;
  compositionOffsets?: Float64Array;
  syncFlags?: Uint8Array;
  offsets: Float64Array;
}

function readSampleSizes(view: DataView, stsz: Mp4Box): { sizes: Uint32Array; sampleCount: number } {
  const { cursor } = openFullBox(view, stsz);
  const uniformSize = cursor.u32();
  const sampleCount = cursor.u32();
  if (sampleCount > MP4_MAX_SAMPLES_PER_TRACK) {
    throw refuse(`stsz claims ${sampleCount} samples, beyond the sample limit of ${MP4_MAX_SAMPLES_PER_TRACK}`);
  }
  const sizes = new Uint32Array(sampleCount);
  if (uniformSize > 0) {
    sizes.fill(uniformSize);
  } else {
    if (sampleCount * 4 > cursor.remaining) throw refuse(`stsz claims ${sampleCount} samples but holds fewer sizes`);
    for (let i = 0; i < sampleCount; i++) sizes[i] = cursor.u32();
  }
  return { sizes, sampleCount };
}

function readDecodeTimes(view: DataView, stts: Mp4Box, sampleCount: number): { deltas: Uint32Array; decodeTimes: Float64Array } {
  const { cursor } = openFullBox(view, stts);
  const entries = tableEntryCount(cursor, 8, 'stts');
  const deltas = new Uint32Array(sampleCount);
  const decodeTimes = new Float64Array(sampleCount);
  let sample = 0;
  let time = 0;
  for (let entry = 0; entry < entries; entry++) {
    const count = cursor.u32();
    const delta = cursor.u32();
    if (count > sampleCount - sample) throw refuse('stts counts more samples than stsz holds');
    for (let i = 0; i < count; i++) {
      decodeTimes[sample] = time;
      deltas[sample] = delta;
      time += delta;
      sample++;
    }
  }
  if (sample !== sampleCount) throw refuse(`stts counts ${sample} samples but stsz holds ${sampleCount}`);
  return { deltas, decodeTimes };
}

function readCompositionOffsets(view: DataView, ctts: Mp4Box, sampleCount: number): Float64Array {
  const { cursor, version } = openFullBox(view, ctts);
  const entries = tableEntryCount(cursor, 8, 'ctts');
  const offsets = new Float64Array(sampleCount);
  let sample = 0;
  for (let entry = 0; entry < entries; entry++) {
    const count = cursor.u32();
    // Version 0 offsets are unsigned and version 1 offsets signed (ISO/IEC 14496-12 8.6.1.3)
    const offset = version === 0 ? cursor.u32() : cursor.i32();
    if (count > sampleCount - sample) throw refuse('ctts counts more samples than stsz holds');
    offsets.fill(offset, sample, sample + count);
    sample += count;
  }
  if (sample !== sampleCount) throw refuse(`ctts counts ${sample} samples but stsz holds ${sampleCount}`);
  return offsets;
}

function readSyncFlags(view: DataView, stss: Mp4Box, sampleCount: number): Uint8Array {
  const { cursor } = openFullBox(view, stss);
  const entries = tableEntryCount(cursor, 4, 'stss');
  const flags = new Uint8Array(sampleCount);
  let previous = 0;
  for (let entry = 0; entry < entries; entry++) {
    const number = cursor.u32();
    if (number <= previous || number > sampleCount) throw refuse(`stss lists sample ${number} out of order or out of range`);
    flags[number - 1] = 1;
    previous = number;
  }
  return flags;
}

function readChunkOffsets(view: DataView, box: Mp4Box): Float64Array {
  const { cursor } = openFullBox(view, box);
  const wide = box.type === 'co64';
  const entries = tableEntryCount(cursor, wide ? 8 : 4, box.type);
  const offsets = new Float64Array(entries);
  for (let i = 0; i < entries; i++) offsets[i] = wide ? cursor.u64() : cursor.u32();
  return offsets;
}

/** File offset of every sample, from the chunk offsets and the sample-to-chunk runs (ISO/IEC 14496-12 8.7.4). */
function mapSamplesToOffsets(view: DataView, stsc: Mp4Box, chunkOffsets: Float64Array, sizes: Uint32Array): Float64Array {
  const { cursor } = openFullBox(view, stsc);
  const runCount = tableEntryCount(cursor, 12, 'stsc');
  const sampleCount = sizes.length;
  const offsets = new Float64Array(sampleCount);
  const chunkCount = chunkOffsets.length;
  let sample = 0;
  let previousFirst = 0;
  let pending: { firstChunk: number; samplesPerChunk: number } | undefined;

  const fill = (run: { firstChunk: number; samplesPerChunk: number }, nextFirstChunk: number): void => {
    for (let chunk = run.firstChunk; chunk < nextFirstChunk; chunk++) {
      let offset = chunkOffsets[chunk - 1];
      for (let i = 0; i < run.samplesPerChunk; i++) {
        if (sample >= sampleCount) throw refuse('stsc maps more samples than stsz holds');
        offsets[sample] = offset;
        offset += sizes[sample];
        sample++;
      }
    }
  };

  for (let i = 0; i < runCount; i++) {
    const firstChunk = cursor.u32();
    const samplesPerChunk = cursor.u32();
    const descriptionIndex = cursor.u32();
    if (descriptionIndex !== 1) throw refuse(`stsc refers to sample description ${descriptionIndex}; only one is read`);
    if (firstChunk <= previousFirst || firstChunk > chunkCount) throw refuse('stsc runs are out of order or beyond the chunk table');
    if (samplesPerChunk === 0) throw refuse('stsc has a run of zero samples per chunk');
    if (pending) fill(pending, firstChunk);
    pending = { firstChunk, samplesPerChunk };
    previousFirst = firstChunk;
  }
  if (pending) fill(pending, chunkCount + 1);
  if (sample !== sampleCount) throw refuse(`stsc maps ${sample} samples but stsz holds ${sampleCount}`);
  return offsets;
}

// ---------------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------------

interface EditTiming {
  /** Media time, in track ticks, that the presentation starts at. */
  mediaTime: number;
  /** Delay before the media starts, in microseconds (leading empty edit). */
  delayMicros: number;
}

/** Leading empty edit plus at most one media edit at rate 1.0; any other edit list cuts or repeats media. */
function readEditTiming(view: DataView, edts: Mp4Box | undefined, movieTimescale: number): EditTiming {
  const none: EditTiming = { mediaTime: 0, delayMicros: 0 };
  const elst = edts ? optionalChild(children(view, edts), 'elst') : undefined;
  if (!elst) return none;
  const { cursor, version } = openFullBox(view, elst);
  const entries = cursor.u32();
  if (entries > MP4_MAX_EDIT_LIST_ENTRIES) throw refuse(`the edit list holds more than ${MP4_MAX_EDIT_LIST_ENTRIES} entries`);
  let emptyTicks = 0;
  let mediaEdits = 0;
  let mediaTime = 0;
  for (let i = 0; i < entries; i++) {
    const segmentDuration = version === 1 ? cursor.u64() : cursor.u32();
    const time = version === 1 ? cursor.i64() : cursor.i32();
    const rateInteger = cursor.i16();
    const rateFraction = cursor.i16();
    if (rateInteger !== EDIT_RATE_ONE || rateFraction !== 0) throw refuse('the edit list changes the playback rate');
    if (time === EMPTY_EDIT_MEDIA_TIME) {
      if (mediaEdits > 0) throw refuse('the edit list has an empty edit after media');
      emptyTicks += segmentDuration;
    } else if (time < 0) {
      throw refuse('the edit list has a negative media time');
    } else {
      mediaEdits++;
      mediaTime = time;
    }
  }
  if (mediaEdits !== 1) throw refuse('the edit list does not present exactly one stretch of media');
  return { mediaTime, delayMicros: Math.round((emptyTicks * MICROS_PER_SECOND) / movieTimescale) };
}

interface ParsedTrack {
  kind: 'video' | 'audio';
  timescale: number;
  codec: string;
  description?: Uint8Array;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  samples: DemuxedMediaSample[];
}

/** tkhd: enabled flag, and for video the 3x3 matrix, which must be the identity. */
function readTrackHeader(view: DataView, tkhd: Mp4Box, checkMatrix: boolean): { enabled: boolean } {
  const { cursor, version, flags } = openFullBox(view, tkhd);
  const enabled = (flags & TKHD_FLAG_ENABLED) !== 0;
  if (!checkMatrix || !enabled) return { enabled };
  // creation, modification, track_ID, reserved, duration; then reserved(8) layer alternate_group volume reserved
  cursor.skip(version === 1 ? 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4);
  cursor.skip(8 + 2 + 2 + 2 + 2);
  for (let i = 0; i < MATRIX_ENTRIES; i++) {
    if (cursor.i32() !== IDENTITY_MATRIX[i]) {
      throw refuse('the video track carries a display transform (rotation, flip or scale) the edge would drop');
    }
  }
  return { enabled };
}

function readMediaTimescale(view: DataView, mdhd: Mp4Box): number {
  const { cursor, version } = openFullBox(view, mdhd);
  cursor.skip(version === 1 ? 16 : 8); // creation and modification times
  const timescale = cursor.u32();
  if (timescale === 0) throw refuse('mdhd has a zero timescale');
  return timescale;
}

function readHandler(view: DataView, hdlr: Mp4Box): string {
  const { cursor } = openFullBox(view, hdlr);
  cursor.skip(4); // pre_defined
  return String.fromCharCode(cursor.u8(), cursor.u8(), cursor.u8(), cursor.u8());
}

interface EntryHeader {
  type: string;
  box: Mp4Box;
}

function readSingleSampleEntry(view: DataView, stsd: Mp4Box): EntryHeader {
  const { cursor } = openFullBox(view, stsd);
  const count = cursor.u32();
  if (count !== 1) throw refuse(`the track has ${count} sample descriptions; exactly one is read`);
  const entries = listBoxes(view, cursor.pos, stsd.end, 'stsd');
  if (entries.length !== 1) throw refuse('stsd holds a different number of entries than it declares');
  return { type: entries[0].type, box: entries[0] };
}

function parseTrack(view: DataView, trak: Mp4Box, buffer: ArrayBuffer, movieTimescale: number): ParsedTrack | undefined {
  const parts = children(view, trak);
  const tkhd = requiredChild(parts, 'tkhd', 'trak');
  const mdia = requiredChild(parts, 'mdia', 'trak');
  const mediaParts = children(view, mdia);
  const handler = readHandler(view, requiredChild(mediaParts, 'hdlr', 'mdia'));
  if (handler !== 'vide' && handler !== 'soun') return undefined; // text, metadata and hint tracks carry no picture or sound
  const kind = handler === 'vide' ? 'video' : 'audio';
  if (!readTrackHeader(view, tkhd, kind === 'video').enabled) return undefined;

  const timescale = readMediaTimescale(view, requiredChild(mediaParts, 'mdhd', 'mdia'));
  const minf = requiredChild(mediaParts, 'minf', 'mdia');
  const stbl = requiredChild(children(view, minf), 'stbl', 'minf');
  const tableBoxes = children(view, stbl);
  const what = `${kind} track`;
  const stsd = requiredChild(tableBoxes, 'stsd', what);
  const stts = requiredChild(tableBoxes, 'stts', what);
  const stsc = requiredChild(tableBoxes, 'stsc', what);
  if (optionalChild(tableBoxes, 'stz2')) throw refuse('compact sample sizes (stz2) are not read');
  const stsz = requiredChild(tableBoxes, 'stsz', what);
  const chunkBox = optionalChild(tableBoxes, 'stco') ?? optionalChild(tableBoxes, 'co64');
  if (!chunkBox) throw refuse(`${what} has no stco or co64 box`);

  // The entry is read first so an unsupported codec is named before the tables are walked.
  const entry = readSingleSampleEntry(view, stsd);
  const fixedBytes = kind === 'video' ? VISUAL_ENTRY_FIXED_BYTES : AUDIO_ENTRY_FIXED_BYTES;
  if (entry.box.end - entry.box.payload < fixedBytes) throw refuse(`${entry.type} sample entry is truncated`);
  const entryChildren = listBoxes(view, entry.box.payload + fixedBytes, entry.box.end, entry.type);

  let track: Omit<ParsedTrack, 'samples' | 'kind' | 'timescale'>;
  if (kind === 'video') {
    const config = videoConfig(view, entry.type, entryChildren);
    const width = view.getUint16(entry.box.payload + VISUAL_ENTRY_WIDTH_OFFSET);
    const height = view.getUint16(entry.box.payload + VISUAL_ENTRY_WIDTH_OFFSET + 2);
    if (width === 0 || height === 0) throw refuse(`${entry.type} sample entry states no frame size`);
    track = { codec: config.codec, description: config.description, width, height };
  } else {
    const version = view.getUint16(entry.box.payload + AUDIO_ENTRY_VERSION_OFFSET);
    if (version !== 0) throw refuse(`audio sample entry version ${version} is not read`);
    const entryChannels = view.getUint16(entry.box.payload + AUDIO_ENTRY_CHANNELS_OFFSET);
    const entryRate = view.getUint32(entry.box.payload + AUDIO_ENTRY_RATE_OFFSET) >>> FIXED_POINT_SHIFT;
    const config = audioConfig(view, entry.type, entryChildren, entryChannels, entryRate);
    track = { codec: config.codec, description: config.description, sampleRate: config.sampleRate, channels: config.channels };
  }

  const { sizes, sampleCount } = readSampleSizes(view, stsz);
  if (sampleCount === 0) throw refuse(`${what} has no samples`);
  const { deltas, decodeTimes } = readDecodeTimes(view, stts, sampleCount);
  const cttsBox = optionalChild(tableBoxes, 'ctts');
  const compositionOffsets = cttsBox ? readCompositionOffsets(view, cttsBox, sampleCount) : undefined;
  const stssBox = optionalChild(tableBoxes, 'stss');
  const syncFlags = stssBox ? readSyncFlags(view, stssBox, sampleCount) : undefined;
  const offsets = mapSamplesToOffsets(view, stsc, readChunkOffsets(view, chunkBox), sizes);
  const edit = readEditTiming(view, optionalChild(parts, 'edts'), movieTimescale);

  const samples: DemuxedMediaSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const size = sizes[i];
    if (size === 0) throw refuse(`${what} has an empty sample`);
    if (offsets[i] + size > buffer.byteLength) throw refuse(`sample ${i} of the ${what} lies outside the file`);
    const presentation = decodeTimes[i] + (compositionOffsets ? compositionOffsets[i] : 0) - edit.mediaTime;
    samples.push({
      data: new Uint8Array(buffer, offsets[i], size),
      timestampMicros: Math.round((presentation * MICROS_PER_SECOND) / timescale) + edit.delayMicros,
      durationMicros: Math.round((deltas[i] * MICROS_PER_SECOND) / timescale),
      // Without stss every sample is a sync sample (ISO/IEC 14496-12 8.6.2)
      isKeyFrame: syncFlags ? syncFlags[i] === 1 : true,
      type: kind,
    });
  }
  return { kind, timescale, ...track, samples };
}

function toTrackInfo(track: ParsedTrack): DemuxedTrackInfo {
  return {
    type: track.kind,
    codec: track.codec,
    timescale: track.timescale,
    width: track.width,
    height: track.height,
    sampleRate: track.sampleRate,
    channels: track.channels,
    description: track.description,
    samples: track.samples,
  };
}

/**
 * Demuxes the video track (with its audio track) or the audio track of an ISO base media file.
 * Throws EdgeUnsupportedError for anything it cannot read exactly.
 */
export function demuxMp4(buffer: ArrayBuffer): DemuxedTrackInfo {
  const view = new DataView(buffer);
  const top = listBoxes(view, 0, buffer.byteLength, 'the file');
  if (top.some((box) => box.type === 'moof')) {
    throw refuse('the file is fragmented (moof boxes); only files with complete sample tables are read');
  }
  const moov = optionalChild(top, 'moov');
  if (!moov) throw refuse('the file has no moov box');
  const movie = children(view, moov);
  if (optionalChild(movie, 'mvex')) throw refuse('the file is fragmented (mvex box)');

  const { cursor: mvhd, version: mvhdVersion } = openFullBox(view, requiredChild(movie, 'mvhd', 'moov'));
  mvhd.skip(mvhdVersion === 1 ? 16 : 8); // creation and modification times
  const movieTimescale = mvhd.u32();
  if (movieTimescale === 0) throw refuse('mvhd has a zero timescale');

  const traks = movie.filter((box) => box.type === 'trak');
  if (traks.length > MP4_MAX_TRACKS) throw refuse(`the file holds more than ${MP4_MAX_TRACKS} tracks`);
  const parsed: ParsedTrack[] = [];
  for (const trak of traks) {
    const track = parseTrack(view, trak, buffer, movieTimescale);
    if (track) parsed.push(track);
  }

  const video = parsed.filter((track) => track.kind === 'video');
  const audio = parsed.filter((track) => track.kind === 'audio');
  if (video.length > 1) throw refuse('the file has more than one video track; the edge cannot choose between them');
  if (audio.length > 1) throw refuse('the file has more than one audio track; the edge cannot choose between them');
  if (video.length === 0 && audio.length === 0) throw refuse('the file has no video or audio track');

  if (video.length === 1) {
    return { ...toTrackInfo(video[0]), audioTrack: audio.length === 1 ? toTrackInfo(audio[0]) : undefined };
  }
  return toTrackInfo(audio[0]);
}
