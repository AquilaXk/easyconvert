/**
 * ISO base media file (MP4 / M4A) muxer for chunks produced by WebCodecs encoders.
 *
 * Everything in the file comes from the encoder: the sample entry and its decoder configuration record are
 * written from `EncoderOutputConfig` (avcC, hvcC and av1C verbatim from `decoderConfig.description`, vpcC from
 * the VP9 codec string, esds around the AudioSpecificConfig), sizes and times from the chunks. A chunk list
 * the container cannot describe truthfully (timestamps that do not increase, a stream that starts on a delta
 * frame, a codec MP4 has no sample entry for, a missing configuration record) throws EdgeUnsupportedError.
 * The layout is fast-start: ftyp, moov, mdat, with the samples of both tracks interleaved in half-second chunks.
 *
 * References: ISO/IEC 14496-12 (boxes, sample tables, edit lists), ISO/IEC 14496-14 (esds, mp4a),
 * ISO/IEC 14496-15 (avcC, hvcC), VP Codec ISO Media File Format Binding (vpcC), AV1 Codec ISO Media File Format
 * Binding (av1C).
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import { AAC_LC_CODEC, AAC_LC_FRAME_SAMPLES, OTI_MPEG4_AUDIO, parseAacLcConfig } from './aac';
import type { EncodedMediaChunk, EncoderOutputConfig, VideoColour } from './media-types';
import { vp9LevelAdmitsPicture } from './codec-levels';
import { isStorableColour } from './video-colour';

/** Samples one track may hold, the same cap the demuxer applies. */
export const MP4_MUX_MAX_SAMPLES_PER_TRACK = 1_000_000;
/** Output size the 32-bit chunk offsets and mdat size can address. */
export const MP4_MUX_MAX_FILE_BYTES = 0xffff_fff0;

const MOVIE_TIMESCALE = 1_000;
/** Video media timescale: microseconds, the unit of WebCodecs timestamps, so no rounding drifts the cadence. */
const VIDEO_TIMESCALE = 1_000_000;
const MICROS_PER_SECOND = 1_000_000;
/** Samples of one track that fall in the same slice of this many microseconds form one chunk in mdat. */
const CHUNK_SLICE_MICROS = 500_000;
const UINT32_LIMIT = 0x1_0000_0000;
const UNDETERMINED_LANGUAGE = 0x55c4; // 'und'
const IDENTITY_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const TKHD_FLAGS_ENABLED_IN_MOVIE = 0x3;
const SAMPLE_RATE_FIXED_POINT_MAX = 0xffff;
const ES_DESCRIPTOR_TAG = 0x03;
const DECODER_CONFIG_DESCRIPTOR_TAG = 0x04;
const DECODER_SPECIFIC_INFO_TAG = 0x05;
const SL_CONFIG_DESCRIPTOR_TAG = 0x06;
/** streamType 5 (audio) in the top six bits, upStream 0, reserved 1. */
const STREAM_TYPE_AUDIO = 0x15;
const SL_CONFIG_PREDEFINED_MP4 = 0x02;
const BITS_PER_BYTE = 8;

function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`MP4 output: ${message}; the server engine converts this file.`);
}

// ---------------------------------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------------------------------

type Part = number[] | Uint8Array;

function bytes(...parts: Part[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** Packs `values` as consecutive big-endian 32-bit integers without spreading them into call arguments. */
function packU32(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]);
  return out;
}

function u64(value: number): number[] {
  return [...u32(Math.floor(value / UINT32_LIMIT)), ...u32(value >>> 0)];
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

function box(type: string, ...payload: Part[]): Uint8Array {
  const body = bytes(...payload);
  return bytes(u32(8 + body.length), ascii(type), body);
}

function fullBox(type: string, version: number, flags: number, ...payload: Part[]): Uint8Array {
  return box(type, [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff], ...payload);
}

// ---------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------

export interface Mp4VideoInput {
  chunks: EncodedMediaChunk[];
  config: EncoderOutputConfig;
  width: number;
  height: number;
  /** The source's colour description; written as `colr` (and into a vpcC) so the output states what the pictures are. */
  colour?: VideoColour;
}

export interface Mp4AudioInput {
  chunks: EncodedMediaChunk[];
  config: EncoderOutputConfig;
  sampleRate: number;
  channels: number;
}

export interface Mp4MuxInput {
  video?: Mp4VideoInput;
  audio?: Mp4AudioInput;
  /** `M4A ` marks an audio-only file (the M4A brand); `isom` is the generic MP4 brand. */
  majorBrand: 'isom' | 'M4A ';
}

// ---------------------------------------------------------------------------------------------------
// Codec configuration boxes
// ---------------------------------------------------------------------------------------------------

interface SampleEntry {
  box: Uint8Array;
  /** Extra ftyp compatible brand the codec calls for, if any. */
  brand?: string;
}

function requireDescription(config: EncoderOutputConfig, what: string): Uint8Array {
  if (!config.description || config.description.byteLength === 0) {
    throw refuse(`the encoder reported no ${what} decoder configuration record for ${config.codec}`);
  }
  return config.description;
}

const VISUAL_ENTRY_PREFIX_BYTES = 6 + 2 + 2 + 2 + 12;
const COMPRESSOR_NAME_BYTES = 32;
const VISUAL_DEPTH = 0x18;
const VISUAL_PREDEFINED_MINUS_ONE = 0xffff;
const DPI_72 = 0x480000;

const COLR_NCLX_FULL_RANGE_FLAG = 0x80;

/** colr of colour type nclx (ISO/IEC 14496-12 12.1.5): code points of ISO/IEC 23091-2 and the range flag. */
function colrBox(colour: VideoColour): Uint8Array {
  return box(
    'colr', ascii('nclx'), u16(colour.primaries), u16(colour.transfer), u16(colour.matrix),
    [colour.fullRange ? COLR_NCLX_FULL_RANGE_FLAG : 0]
  );
}

/** VisualSampleEntry (ISO/IEC 14496-12 12.1.3) around one codec configuration box, then the colour if known. */
function visualEntry(type: string, width: number, height: number, configBox: Uint8Array, colour?: VideoColour): Uint8Array {
  return box(
    type,
    new Array(6).fill(0), u16(1), // reserved, data_reference_index
    new Array(VISUAL_ENTRY_PREFIX_BYTES - 8).fill(0),
    u16(width), u16(height), u32(DPI_72), u32(DPI_72), u32(0), u16(1),
    new Array(COMPRESSOR_NAME_BYTES).fill(0), u16(VISUAL_DEPTH), u16(VISUAL_PREDEFINED_MINUS_ONE),
    configBox,
    ...(colour ? [colrBox(colour)] : [])
  );
}

const VP9_DEFAULT_CHROMA = 1;
const VP9_MAX_PROFILE = 3;
const VP9_MAX_CHROMA_SUBSAMPLING = 3;
/** The pictures each VP9 profile carries (VP9 bitstream specification, profile definitions): bit depths and vpcC chroma codes. */
const VP9_PROFILES: ReadonlyArray<{ bitDepths: ReadonlySet<number>; chroma: ReadonlySet<number> }> = [
  { bitDepths: new Set([8]), chroma: new Set([0, 1]) },
  { bitDepths: new Set([8]), chroma: new Set([2, 3]) },
  { bitDepths: new Set([10, 12]), chroma: new Set([0, 1]) },
  { bitDepths: new Set([10, 12]), chroma: new Set([2, 3]) },
];
const VP9_BIT_DEPTHS: ReadonlySet<number> = new Set([8, 10, 12]);
/** Profiles 0 and 2 are 4:2:0 only, so a codec string may leave the chroma out; 1 and 3 must state it. */
const VP9_PROFILES_IMPLYING_420: ReadonlySet<number> = new Set([0, 2]);
/** The largest width or height a VisualSampleEntry (16 bits) and tkhd (16.16 fixed point) can state. */
export const MP4_MUX_MAX_PICTURE_DIMENSION = 0xffff;
/** BT.709 code points, limited range: what a VP9 codec string means when it states no colour. */
const VP9_DEFAULT_COLOUR: VideoColour = { primaries: 1, transfer: 1, matrix: 1, fullRange: false };
const VPCC_VERSION = 1;
const VP9_MIN_CODEC_FIELDS = 3;

function describeColour(colour: VideoColour): string {
  return `${colour.primaries}/${colour.transfer}/${colour.matrix} ${colour.fullRange ? 'full' : 'limited'} range`;
}

/**
 * vpcC (VP Codec ISO Media File Format Binding 2.2) from a `vp09.PP.LL.DD[.CC.cp.tc.mc.FF]` codec string. The
 * optional fields take the colour of the source when it has one, else the defaults the binding names (4:2:0
 * co-located, BT.709 colour, limited range). A codec string that states a colour other than the source's throws.
 */
function vp9ConfigBox(codec: string, width: number, height: number, source?: VideoColour): Uint8Array {
  const fields = codec.split('.').slice(1).map((part) => Number(part));
  if (fields.length < VP9_MIN_CODEC_FIELDS || fields.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw refuse(`${codec} is not a VP9 codec string with profile, level and bit depth`);
  }
  const [profile, level, bitDepth] = fields;
  if (profile > VP9_MAX_PROFILE) throw refuse(`VP9 profile ${profile} is not 0 to ${VP9_MAX_PROFILE}`);
  if (!VP9_BIT_DEPTHS.has(bitDepth)) throw refuse(`VP9 bit depth ${bitDepth} is not 8, 10 or 12`);
  if (fields[3] !== undefined && fields[3] > VP9_MAX_CHROMA_SUBSAMPLING) {
    throw refuse(`VP9 chroma subsampling ${fields[3]} is not 0 to ${VP9_MAX_CHROMA_SUBSAMPLING}`);
  }
  if (fields[3] === undefined && !VP9_PROFILES_IMPLYING_420.has(profile)) {
    throw refuse(`the codec string ${codec} states no chroma subsampling, which VP9 profile ${profile} does not imply`);
  }
  const chroma = fields[3] ?? VP9_DEFAULT_CHROMA;
  if (!VP9_PROFILES[profile].bitDepths.has(bitDepth) || !VP9_PROFILES[profile].chroma.has(chroma)) {
    throw refuse(`VP9 profile ${profile} does not carry ${bitDepth}-bit pictures with chroma subsampling ${chroma}`);
  }
  if (!vp9LevelAdmitsPicture(level, 1, 1)) throw refuse(`the VP9 level ${level} is not a level of the VP9 specification`);
  if (!vp9LevelAdmitsPicture(level, width, height)) {
    throw refuse(`the VP9 level ${level} does not admit a ${width}x${height} picture`);
  }
  const fallback = source ?? VP9_DEFAULT_COLOUR;
  const stated: VideoColour = {
    primaries: fields[4] ?? fallback.primaries,
    transfer: fields[5] ?? fallback.transfer,
    matrix: fields[6] ?? fallback.matrix,
    fullRange: fields[7] === undefined ? fallback.fullRange : fields[7] === 1,
  };
  if (source && describeColour(stated) !== describeColour(source)) {
    throw refuse(`the codec string ${codec} states colour ${describeColour(stated)}, not the source's ${describeColour(source)}`);
  }
  const { primaries, transfer, matrix } = stated;
  const fullRange = stated.fullRange ? 1 : 0;
  return fullBox(
    'vpcC', VPCC_VERSION, 0,
    [profile, level, (bitDepth << 4) | (chroma << 1) | fullRange, primaries, transfer, matrix],
    u16(0) // codecInitializationDataSize
  );
}

function videoSampleEntry(input: Mp4VideoInput): SampleEntry {
  const { config, width, height, colour } = input;
  const codec = config.codec;
  if (colour && !isStorableColour(colour)) {
    throw refuse('the colour description holds colour code points that are not whole numbers from 0 to 255');
  }
  if (codec.startsWith('avc1.')) {
    return { box: visualEntry('avc1', width, height, box('avcC', requireDescription(config, 'avcC')), colour), brand: 'avc1' };
  }
  if (codec.startsWith('hvc1.') || codec.startsWith('hev1.')) {
    // The encoder's HEVC output keeps its parameter sets in hvcC, which is what an hvc1 entry means
    return { box: visualEntry('hvc1', width, height, box('hvcC', requireDescription(config, 'hvcC')), colour) };
  }
  if (codec.startsWith('vp09.')) {
    return { box: visualEntry('vp09', width, height, vp9ConfigBox(codec, width, height, colour), colour) };
  }
  if (codec.startsWith('av01.')) {
    return { box: visualEntry('av01', width, height, box('av1C', requireDescription(config, 'av1C')), colour), brand: 'av01' };
  }
  throw refuse(`${codec} has no MP4 sample entry in this muxer`);
}

function expandableLength(length: number): number[] {
  // Always four bytes of seven bits each (ISO/IEC 14496-1 8.3.3 allows it), so the size never depends on the value
  return [0x80 | ((length >>> 21) & 0x7f), 0x80 | ((length >>> 14) & 0x7f), 0x80 | ((length >>> 7) & 0x7f), length & 0x7f];
}

function descriptor(tag: number, ...payload: Part[]): Uint8Array {
  const body = bytes(...payload);
  return bytes([tag], expandableLength(body.length), body);
}

/** esds (ISO/IEC 14496-14 5.6) around the AudioSpecificConfig, with rates measured from the chunks. */
function esdsBox(asc: Uint8Array, chunks: EncodedMediaChunk[], totalMicros: number): Uint8Array {
  const maxChunk = chunks.reduce((max, chunk) => Math.max(max, chunk.data.byteLength), 0);
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  const averageBitrate = Math.round((totalBytes * BITS_PER_BYTE * MICROS_PER_SECOND) / totalMicros);
  const peak = chunks.reduce((max, chunk, index) => {
    const duration = chunkDurationMicros(chunks, index);
    return Math.max(max, Math.round((chunk.data.byteLength * BITS_PER_BYTE * MICROS_PER_SECOND) / duration));
  }, 0);
  const decoderConfig = descriptor(
    DECODER_CONFIG_DESCRIPTOR_TAG,
    [OTI_MPEG4_AUDIO, STREAM_TYPE_AUDIO], [(maxChunk >>> 16) & 0xff, (maxChunk >>> 8) & 0xff, maxChunk & 0xff],
    u32(peak), u32(averageBitrate),
    descriptor(DECODER_SPECIFIC_INFO_TAG, asc)
  );
  return fullBox(
    'esds', 0, 0,
    descriptor(ES_DESCRIPTOR_TAG, u16(0), [0], decoderConfig, descriptor(SL_CONFIG_DESCRIPTOR_TAG, [SL_CONFIG_PREDEFINED_MP4]))
  );
}

const AUDIO_SAMPLE_SIZE_BITS = 16;

function audioSampleEntry(input: Mp4AudioInput, totalMicros: number): Uint8Array {
  const { config, sampleRate, channels, chunks } = input;
  if (config.codec !== AAC_LC_CODEC) throw refuse(`${config.codec} has no MP4 sample entry in this muxer`);
  const asc = requireDescription(config, 'AudioSpecificConfig');
  const parsed = parseAacLcConfig(asc);
  if (parsed.sampleRate !== sampleRate || parsed.channels !== channels) {
    throw refuse(
      `the AudioSpecificConfig states ${parsed.sampleRate} Hz and ${parsed.channels} channels, not the ${sampleRate} Hz and ${channels} channels encoded`
    );
  }
  // A rate beyond 16 bits does not fit the sample entry; the esds carries it (ISO/IEC 14496-12 12.2.3)
  const entryRate = sampleRate <= SAMPLE_RATE_FIXED_POINT_MAX ? sampleRate : 0;
  return box(
    'mp4a',
    new Array(6).fill(0), u16(1), // reserved, data_reference_index
    u16(0), u16(0), u32(0), // entry version, revision, vendor
    u16(channels), u16(AUDIO_SAMPLE_SIZE_BITS), u16(0), u16(0), u32(entryRate * 0x10000),
    esdsBox(asc, chunks, totalMicros)
  );
}

// ---------------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------------

interface Sample {
  size: number;
  /** Start time in the track's media timescale, from the first sample's timestamp. */
  start: number;
  duration: number;
  key: boolean;
  data: Uint8Array;
  /** Start time in microseconds from the first sample. */
  startMicros: number;
}

interface TrackPlan {
  kind: 'video' | 'audio';
  trackId: number;
  timescale: number;
  samples: Sample[];
  entry: Uint8Array;
  width: number;
  height: number;
  /** Microseconds the first sample starts after time zero; becomes an empty edit. */
  startOffsetMicros: number;
  /** Media ticks at the start that are encoder delay, not programme: the edit list starts the media after them. */
  primingTicks: number;
  mediaDuration: number;
  allKey: boolean;
}

/** Duration of chunk `index` in microseconds: the next timestamp's distance, or the last chunk's own duration. */
function chunkDurationMicros(chunks: EncodedMediaChunk[], index: number): number {
  if (index + 1 < chunks.length) return chunks[index + 1].timestampMicros - chunks[index].timestampMicros;
  const own = chunks[index].durationMicros;
  if (own !== undefined && own > 0) return own;
  if (chunks.length >= 2) return chunks[index].timestampMicros - chunks[index - 1].timestampMicros;
  throw refuse('the only chunk of a track carries no duration');
}

function planSamples(kind: 'video' | 'audio', chunks: EncodedMediaChunk[], timescale: number): {
  samples: Sample[];
  startOffsetMicros: number;
  mediaDuration: number;
  allKey: boolean;
} {
  if (chunks.length === 0) throw refuse(`the ${kind} track has no chunks`);
  if (chunks.length > MP4_MUX_MAX_SAMPLES_PER_TRACK) {
    throw refuse(`the ${kind} track has more than ${MP4_MUX_MAX_SAMPLES_PER_TRACK} chunks (sample limit)`);
  }
  if (kind === 'video' && !chunks[0].isKeyFrame) throw refuse('the video stream starts on a delta frame');
  const first = chunks[0].timestampMicros;
  if (first < 0) throw refuse(`the ${kind} track starts before time zero`);

  const starts: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const chunk of chunks) {
    if (chunk.data.byteLength === 0) throw refuse(`the ${kind} track has an empty chunk`);
    if (chunk.timestampMicros <= previous) {
      throw refuse(`the ${kind} chunks do not have strictly increasing timestamps (the encoder reordered frames)`);
    }
    previous = chunk.timestampMicros;
    starts.push(Math.round(((chunk.timestampMicros - first) * timescale) / MICROS_PER_SECOND));
  }
  const lastEnd = Math.round(
    ((chunks[chunks.length - 1].timestampMicros - first + chunkDurationMicros(chunks, chunks.length - 1)) * timescale) /
      MICROS_PER_SECOND
  );

  const samples: Sample[] = chunks.map((chunk, index) => {
    const end = index + 1 < chunks.length ? starts[index + 1] : lastEnd;
    if (end <= starts[index]) throw refuse(`the ${kind} track has two chunks that fall in one tick of its timescale`);
    return {
      size: chunk.data.byteLength,
      start: starts[index],
      duration: end - starts[index],
      key: chunk.isKeyFrame,
      data: chunk.data,
      startMicros: chunk.timestampMicros - first,
    };
  });
  return {
    samples,
    startOffsetMicros: first,
    mediaDuration: lastEnd,
    allKey: samples.every((sample) => sample.key),
  };
}

function videoPlan(input: Mp4VideoInput, trackId: number): { plan: TrackPlan; brand?: string } {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    throw refuse('the video frame size is not a positive whole number');
  }
  if (input.width > MP4_MUX_MAX_PICTURE_DIMENSION || input.height > MP4_MUX_MAX_PICTURE_DIMENSION) {
    throw refuse(
      `the video frame ${input.width}x${input.height} is larger than the ${MP4_MUX_MAX_PICTURE_DIMENSION} pixels a sample entry and track header can state`
    );
  }
  const entry = videoSampleEntry(input);
  const timing = planSamples('video', input.chunks, VIDEO_TIMESCALE);
  return {
    plan: { kind: 'video', trackId, timescale: VIDEO_TIMESCALE, entry: entry.box, width: input.width, height: input.height, primingTicks: 0, ...timing },
    brand: entry.brand,
  };
}

function audioPlan(input: Mp4AudioInput, trackId: number): TrackPlan {
  const timing = planSamples('audio', input.chunks, input.sampleRate);
  const totalMicros = Math.round((timing.mediaDuration * MICROS_PER_SECOND) / input.sampleRate);
  // An AAC-LC encoder's output opens with one frame of priming (its MDCT overlap), which a player must not present
  if (timing.mediaDuration <= AAC_LC_FRAME_SAMPLES) {
    throw refuse(`the audio is not longer than the ${AAC_LC_FRAME_SAMPLES} samples of encoder delay its edit list has to hide`);
  }
  return {
    kind: 'audio',
    trackId,
    timescale: input.sampleRate,
    entry: audioSampleEntry(input, totalMicros),
    width: 0,
    height: 0,
    primingTicks: AAC_LC_FRAME_SAMPLES,
    ...timing,
  };
}

// ---------------------------------------------------------------------------------------------------
// Boxes of one track
// ---------------------------------------------------------------------------------------------------

function runLengths(values: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === value) last[0]++;
    else runs.push([1, value]);
  }
  return runs;
}

interface ChunkPlan {
  track: number;
  /** Index of the first sample in the track. */
  first: number;
  count: number;
  bytes: number;
}

/** Groups samples into mdat chunks: per half-second slice, the video samples, then the audio samples. */
function planChunks(plans: TrackPlan[]): ChunkPlan[] {
  const slices = new Map<number, Array<{ track: number; first: number; count: number; bytes: number }>>();
  plans.forEach((plan, track) => {
    plan.samples.forEach((sample, index) => {
      const slice = Math.floor((plan.startOffsetMicros + sample.startMicros) / CHUNK_SLICE_MICROS);
      const groups = slices.get(slice) ?? [];
      const last = groups.find((group) => group.track === track);
      if (last) {
        last.count++;
        last.bytes += sample.size;
      } else {
        groups.push({ track, first: index, count: 1, bytes: sample.size });
      }
      slices.set(slice, groups);
    });
  });
  return [...slices.keys()]
    .sort((a, b) => a - b)
    .flatMap((slice) => (slices.get(slice) ?? []).sort((a, b) => a.track - b.track));
}

/** Movie-timescale length of the part of the media the edit list presents: the media after its priming. */
function presentedMovieTicks(plan: TrackPlan): number {
  return Math.round(((plan.mediaDuration - plan.primingTicks) * MOVIE_TIMESCALE) / plan.timescale);
}

function startDelayMovieTicks(plan: TrackPlan): number {
  return Math.round((plan.startOffsetMicros * MOVIE_TIMESCALE) / MICROS_PER_SECOND);
}

/**
 * The edit list of a track: an empty edit for the time before its first sample, then the media from its first
 * presented sample, which is after any encoder priming (ISO/IEC 14496-12 8.6.6). A track that starts at zero and
 * has no priming needs none. A start offset below the movie timescale's resolution is not representable and is
 * not an offset.
 */
function elstBox(plan: TrackPlan): Uint8Array | undefined {
  const delay = startDelayMovieTicks(plan);
  if (delay === 0 && plan.primingTicks === 0) return undefined;
  const entries: Uint8Array[] = [];
  if (delay > 0) entries.push(bytes(u32(delay), u32(0xffffffff), u16(1), u16(0)));
  entries.push(bytes(u32(presentedMovieTicks(plan)), u32(plan.primingTicks), u16(1), u16(0)));
  return box('edts', fullBox('elst', 0, 0, u32(entries.length), ...entries));
}

function trackDurationInMovie(plan: TrackPlan): number {
  return presentedMovieTicks(plan) + startDelayMovieTicks(plan);
}

function trakBox(plan: TrackPlan, chunks: ChunkPlan[], trackIndex: number, chunkOffsets: number[]): Uint8Array {
  const isVideo = plan.kind === 'video';
  const tkhd = fullBox(
    'tkhd', 0, TKHD_FLAGS_ENABLED_IN_MOVIE,
    u32(0), u32(0), u32(plan.trackId), u32(0), u32(trackDurationInMovie(plan)),
    new Array(8).fill(0), u16(0), u16(0), u16(isVideo ? 0 : 0x100), u16(0),
    IDENTITY_MATRIX.flatMap((value) => u32(value)),
    u32(plan.width * 0x10000), u32(plan.height * 0x10000)
  );
  const durationTicks = plan.mediaDuration;
  const mdhd =
    durationTicks >= UINT32_LIMIT
      ? fullBox('mdhd', 1, 0, u64(0), u64(0), u32(plan.timescale), u64(durationTicks), u16(UNDETERMINED_LANGUAGE), u16(0))
      : fullBox('mdhd', 0, 0, u32(0), u32(0), u32(plan.timescale), u32(durationTicks), u16(UNDETERMINED_LANGUAGE), u16(0));
  const hdlr = fullBox(
    'hdlr', 0, 0, u32(0), ascii(isVideo ? 'vide' : 'soun'), new Array(12).fill(0),
    ascii(isVideo ? 'VideoHandler' : 'SoundHandler'), [0]
  );
  const mediaHeader = isVideo
    ? fullBox('vmhd', 0, 1, new Array(8).fill(0))
    : fullBox('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

  const durationRuns = runLengths(plan.samples.map((sample) => sample.duration));
  const stts = fullBox('stts', 0, 0, u32(durationRuns.length), packU32(durationRuns.flat()));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(plan.samples.length), packU32(plan.samples.map((sample) => sample.size)));

  const ownChunks = chunks.filter((chunk) => chunk.track === trackIndex);
  const chunkRuns = runLengths(ownChunks.map((chunk) => chunk.count));
  let chunkNumber = 1;
  const stscValues: number[] = [];
  for (const [runChunks, samplesPerChunk] of chunkRuns) {
    stscValues.push(chunkNumber, samplesPerChunk, 1);
    chunkNumber += runChunks;
  }
  const stsc = fullBox('stsc', 0, 0, u32(chunkRuns.length), packU32(stscValues));
  const stco = fullBox('stco', 0, 0, u32(chunkOffsets.length), packU32(chunkOffsets));

  const syncNumbers = plan.samples.flatMap((sample, index) => (sample.key ? [index + 1] : []));
  const stss = plan.allKey ? [] : [fullBox('stss', 0, 0, u32(syncNumbers.length), packU32(syncNumbers))];

  const stbl = box('stbl', fullBox('stsd', 0, 0, u32(1), plan.entry), stts, ...stss, stsc, stsz, stco);
  const minf = box('minf', mediaHeader, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const edts = elstBox(plan);
  return box('trak', tkhd, ...(edts ? [edts] : []), mdia);
}

function ftypBox(input: Mp4MuxInput, codecBrands: string[]): Uint8Array {
  if (input.majorBrand === 'M4A ') {
    return box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'));
  }
  const brands = ['isom', 'iso2', ...codecBrands, 'mp41'];
  return box('ftyp', ascii('isom'), u32(0x200), ...brands.map((brand) => ascii(brand)));
}

/** Writes an MP4 (or M4A) file from encoded chunks and the encoders' own decoder configurations. */
export function muxMp4(input: Mp4MuxInput): Uint8Array {
  if (!input.video && !input.audio) throw refuse('there is no track to write');
  if (input.majorBrand === 'M4A ' && (input.video || !input.audio)) {
    throw refuse('an M4A file holds audio and no video');
  }
  const plans: TrackPlan[] = [];
  const codecBrands: string[] = [];
  if (input.video) {
    const { plan, brand } = videoPlan(input.video, plans.length + 1);
    plans.push(plan);
    if (brand) codecBrands.push(brand);
  }
  if (input.audio) plans.push(audioPlan(input.audio, plans.length + 1));

  const chunks = planChunks(plans);
  const ftyp = ftypBox(input, codecBrands);

  const build = (mdatDataStart: number): { moov: Uint8Array; end: number } => {
    let cursor = mdatDataStart;
    const offsetsByTrack = plans.map(() => [] as number[]);
    for (const chunk of chunks) {
      offsetsByTrack[chunk.track].push(cursor);
      cursor += chunk.bytes;
    }
    const duration = Math.max(...plans.map(trackDurationInMovie));
    const mvhd = fullBox(
      'mvhd', 0, 0,
      u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(duration), u32(0x10000), u16(0x100), new Array(10).fill(0),
      IDENTITY_MATRIX.flatMap((value) => u32(value)), new Array(24).fill(0), u32(plans.length + 1)
    );
    const moov = box('moov', mvhd, ...plans.map((plan, index) => trakBox(plan, chunks, index, offsetsByTrack[index])));
    return { moov, end: cursor };
  };

  // stco entries have a fixed width, so the moov size does not depend on the offsets it holds
  const measured = build(0).moov.byteLength;
  const mdatDataStart = ftyp.byteLength + measured + 8;
  const { moov, end } = build(mdatDataStart);
  if (end > MP4_MUX_MAX_FILE_BYTES) throw refuse('the output would exceed the 32-bit file offsets this muxer writes');

  const out = new Uint8Array(end);
  out.set(ftyp, 0);
  out.set(moov, ftyp.byteLength);
  out.set(bytes(u32(end - ftyp.byteLength - moov.byteLength), ascii('mdat')), ftyp.byteLength + moov.byteLength);

  // Sample bytes in chunk order, each chunk's samples back to back
  const nextSample = plans.map(() => 0);
  let cursor = mdatDataStart;
  for (const chunk of chunks) {
    const plan = plans[chunk.track];
    for (let i = 0; i < chunk.count; i++) {
      const sample = plan.samples[nextSample[chunk.track]++];
      out.set(sample.data, cursor);
      cursor += sample.size;
    }
  }
  return out;
}
