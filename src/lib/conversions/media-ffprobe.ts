import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ConversionFailedError,
  EngineUnavailableError,
  MediaProbeError,
  NoVideoStreamError,
  TooManyMediaStreamsError,
} from '../types';
import { type LayoutStream, readMp4Layout } from './mp4-layout';
import { readWavPcmInfo } from './wav-header';

/**
 * ffprobe access for the media conversions: the binary lookup, the scalar probes the argument
 * builders use, and bounded JSON probes of the stream list and the first video stream.
 */

let cachedFfprobeBin: string | null = null;
function getInternalFfprobe(): string | null {
  if (cachedFfprobeBin !== null) return cachedFfprobeBin || null;
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    cachedFfprobeBin = envPath;
    return envPath;
  }
  const fixedLocations = [
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/opt/homebrew/bin/ffprobe',
    '/bin/ffprobe',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      cachedFfprobeBin = loc;
      return loc;
    }
  }
  cachedFfprobeBin = '';
  return null;
}

/** Path of an ffprobe binary. Branded so an ffmpeg path cannot be passed by mistake. */
export type FfprobePath = string & { readonly __brand: 'FfprobePath' };

const FFPROBE_TIMEOUT_MS = 10_000;
/** The JSON of a 64-stream file with long tags stays far below this; a larger report is not a media file. */
const MAX_FFPROBE_JSON_BYTES = 4 * 1024 * 1024;
/** Most streams one conversion maps. Probing and `-map` lists grow with the stream count, so it is bounded. */
export const MAX_MAPPED_STREAMS = 64;
/** Highest frame rate accepted from a probe; a larger r_frame_rate is a timebase artefact of variable-rate input. */
export const MAX_PROBED_FPS = 240;
/** r_frame_rate and avg_frame_rate that differ by more than this share mean variable frame rate. */
const VFR_RATE_TOLERANCE = 0.01;
const FRAME_RATE_PATTERN = /^(\d{1,9})\/(\d{1,9})$/;
const QUARTER_TURN_DEGREES = 90;
const HALF_TURN_DEGREES = 180;
const BITS_PER_KILOBIT = 1000;

/**
 * Resolves the ffprobe binary that belongs to an ffmpeg installation: the sibling of `ffmpegBin`
 * when present, otherwise `FFPROBE_PATH` or a standard location. Throws when none exists.
 */
export function resolveFfprobeBinary(ffmpegBin?: string | null): FfprobePath {
  const override = process.env.FFPROBE_PATH;
  if (override && !fs.existsSync(override)) {
    // An explicit override that names no file means ffprobe is not installed; do not search elsewhere.
    throw new EngineUnavailableError('ffprobe', 'ffprobe is required to inspect media streams but was not found.');
  }
  if (ffmpegBin) {
    const sibling = path.join(path.dirname(ffmpegBin), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(sibling)) {
      return sibling as FfprobePath;
    }
  }
  const found = getInternalFfprobe();
  if (!found) {
    throw new EngineUnavailableError('ffprobe', 'ffprobe is required to inspect media streams but was not found.');
  }
  return found as FfprobePath;
}

function runFfprobe(ffprobe: FfprobePath, filePath: string, args: string[]): string {
  try {
    return execFileSync(ffprobe, ['-v', 'error', ...args, '-of', 'default=noprint_wrappers=1:nokey=1', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FFPROBE_TIMEOUT_MS,
    })
      .toString('utf-8')
      .trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConversionFailedError(`ffprobe could not inspect the input media: ${detail}`);
  }
}

/**
 * Number of channels in the selected audio stream (the first by default), or 0 when the file has no audio stream.
 * Throws when ffprobe cannot read the file instead of reporting a silent input.
 */
export function probeAudioChannels(filePath: string, ffprobe: FfprobePath, streamIndex = 0): number {
  const out = runFfprobe(ffprobe, filePath, ['-select_streams', `a:${streamIndex}`, '-show_entries', 'stream=channels']);
  if (out === '') {
    return 0;
  }
  const parsed = Number.parseInt(out, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConversionFailedError(`ffprobe reported an invalid audio channel count: "${out}"`);
  }
  return parsed;
}

/** Number of audio streams in the file; 0 when it has none. Throws when ffprobe cannot read the file. */
export function probeAudioStreamCount(filePath: string, ffprobe: FfprobePath): number {
  // A WAVE file with uncompressed samples has exactly one audio stream; its header says so without a process.
  if (readWavPcmInfo(filePath) !== null) return 1;
  const out = runFfprobe(ffprobe, filePath, ['-select_streams', 'a', '-show_entries', 'stream=index']);
  return out === '' ? 0 : out.split('\n').length;
}

/** Sample rate in Hz of the selected audio stream (the first by default), or 0 when it has none. */
export function probeAudioSampleRate(filePath: string, ffprobe: FfprobePath, streamIndex = 0): number {
  const out = runFfprobe(ffprobe, filePath, ['-select_streams', `a:${streamIndex}`, '-show_entries', 'stream=sample_rate']);
  if (out === '') {
    return 0;
  }
  const parsed = Number.parseInt(out, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConversionFailedError(`ffprobe reported an invalid audio sample rate: "${out}"`);
  }
  return parsed;
}

export type InputStreamType = 'video' | 'audio' | 'subtitle' | 'attachment' | 'data';

export interface InputStream {
  /** Absolute stream index in the input; `-map 0:<index>` selects exactly this stream. */
  index: number;
  type: InputStreamType;
  codecName: string;
  /** Cover art stored as a video stream (disposition attached_pic); it is not a video track. */
  attachedPicture: boolean;
  /** Display-matrix rotation in degrees, counter-clockwise as ffprobe reports it; 0 when absent. */
  rotation: number;
  width?: number;
  height?: number;
  frameRate?: { num: number; den: number };
  /** Rate averaged over the stream (frames / duration), when it differs from the base rate. */
  averageFrameRate?: { num: number; den: number };
  bitRateK?: number;
  /** Track title from the stream's tags, when it has one. */
  title?: string;
  /** Language tag (usually ISO 639-2, such as `eng`), when the stream has one. */
  language?: string;
  /** Transfer characteristic of a video stream (`bt709`, `smpte2084`, `arib-std-b67`), when the stream states one. */
  colorTransfer?: string;
}

interface RawStream {
  index?: unknown;
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  r_frame_rate?: unknown;
  avg_frame_rate?: unknown;
  bit_rate?: unknown;
  disposition?: { attached_pic?: unknown };
  tags?: { title?: unknown; language?: unknown };
  color_transfer?: unknown;
  side_data_list?: Array<{ rotation?: unknown }>;
}

const STREAM_TYPES: Readonly<Record<string, InputStreamType>> = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  attachment: 'attachment',
  data: 'data',
};

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseFrameRate(value: unknown): { num: number; den: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = FRAME_RATE_PATTERN.exec(value);
  if (!match) return undefined;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (num <= 0 || den <= 0 || num / den > MAX_PROBED_FPS) return undefined;
  return { num, den };
}

function displayRotation(raw: RawStream): number {
  for (const entry of raw.side_data_list ?? []) {
    if (typeof entry.rotation === 'number' && Number.isFinite(entry.rotation)) {
      return entry.rotation;
    }
  }
  return 0;
}

function toInputStream(raw: RawStream): InputStream {
  const index = typeof raw.index === 'number' && Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : undefined;
  if (index === undefined) {
    throw new MediaProbeError('ffprobe reported a stream without an index.');
  }
  const type = typeof raw.codec_type === 'string' && Object.hasOwn(STREAM_TYPES, raw.codec_type)
    ? STREAM_TYPES[raw.codec_type]
    : 'data';
  const bitRate = typeof raw.bit_rate === 'string' ? Number(raw.bit_rate) : Number.NaN;
  return {
    index,
    type,
    codecName: typeof raw.codec_name === 'string' ? raw.codec_name : 'unknown',
    attachedPicture: raw.disposition?.attached_pic === 1,
    rotation: displayRotation(raw),
    width: positiveInt(raw.width),
    height: positiveInt(raw.height),
    frameRate: parseFrameRate(raw.r_frame_rate),
    averageFrameRate: parseFrameRate(raw.avg_frame_rate),
    bitRateK: Number.isFinite(bitRate) && bitRate > 0 ? Math.round(bitRate / BITS_PER_KILOBIT) : undefined,
    title: typeof raw.tags?.title === 'string' && raw.tags.title !== '' ? raw.tags.title : undefined,
    language: typeof raw.tags?.language === 'string' && raw.tags.language !== '' ? raw.tags.language : undefined,
    colorTransfer: typeof raw.color_transfer === 'string' && raw.color_transfer !== '' ? raw.color_transfer : undefined,
  };
}

export interface InputTimeline {
  /** Start of the container's timeline in seconds: the earliest stream start, negative for an encoder-delay audio track. */
  startTimeSec: number;
  chapterCount: number;
}

/** Everything one ffprobe run reports about an input, so a conversion inspects the file once. */
export interface InputProbe {
  streams: InputStream[];
  timeline: InputTimeline;
  /** Container duration in seconds, when the container states a positive one. */
  durationSec?: number;
}

/** Inputs whose probe is remembered: a conversion asks for it from the planner, the metadata and the duration check. */
const PROBE_CACHE_ENTRIES = 16;
const probeCache = new Map<string, InputProbe>();

/** Identity of the bytes on disk: a rewritten file changes at least one of these, so its probe is never reused. */
function fileIdentity(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    return [filePath, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join('\0');
  } catch {
    return undefined;
  }
}

/** Forgets every remembered probe (tests that rewrite a file in place). */
export function resetInputProbeCache(): void {
  probeCache.clear();
}

/**
 * ffprobe's report of every stream, the container start time and duration, and the chapter ids (by id only, so a
 * file with thousands of chapters stays within the JSON limit; a larger report is not a media file).
 */
const INPUT_PROBE_ARGS = ['-v', 'error', '-show_streams', '-show_entries', 'format=start_time,duration:chapter=id', '-of', 'json'];

/**
 * One ffprobe run over `filePath` for the stream list, the timeline and the duration. The result is remembered
 * for the file as it is on disk, so the planner, the metadata that names dropped streams and the duration check of
 * one conversion cost one process between them. More than MAX_MAPPED_STREAMS streams throws
 * TooManyMediaStreamsError, so no later step lists or maps an unbounded number of streams.
 */
export function probeInput(filePath: string, ffprobe: FfprobePath): InputProbe {
  const identity = fileIdentity(filePath);
  const remembered = identity === undefined ? undefined : probeCache.get(identity);
  if (remembered) return remembered;

  let stdout: string;
  try {
    stdout = execFileSync(ffprobe, [...INPUT_PROBE_ARGS, filePath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FFPROBE_TIMEOUT_MS,
      maxBuffer: MAX_FFPROBE_JSON_BYTES,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConversionFailedError(`ffprobe could not inspect the input media: ${detail}`);
  }
  let parsed: { streams?: unknown; format?: { start_time?: unknown; duration?: unknown }; chapters?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new MediaProbeError('ffprobe did not return valid JSON for the input media.');
  }
  if (!Array.isArray(parsed.streams)) {
    throw new MediaProbeError('ffprobe reported no stream list for the input media.');
  }
  if (parsed.streams.length > MAX_MAPPED_STREAMS) {
    throw new TooManyMediaStreamsError(
      `The input has ${parsed.streams.length} streams; a conversion maps at most ${MAX_MAPPED_STREAMS}.`
    );
  }
  const start = typeof parsed.format?.start_time === 'string' ? Number(parsed.format.start_time) : 0;
  const duration = typeof parsed.format?.duration === 'string' ? Number.parseFloat(parsed.format.duration) : Number.NaN;
  const probe: InputProbe = {
    streams: (parsed.streams as RawStream[]).map(toInputStream),
    timeline: {
      startTimeSec: Number.isFinite(start) ? start : 0,
      chapterCount: Array.isArray(parsed.chapters) ? parsed.chapters.length : 0,
    },
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
  };
  if (identity !== undefined) {
    if (probeCache.size >= PROBE_CACHE_ENTRIES) probeCache.delete(probeCache.keys().next().value as string);
    probeCache.set(identity, probe);
  }
  return probe;
}

/** The stream facts and the chapter list a conversion plans its mapping from. */
export interface StreamLayout {
  streams: LayoutStream[];
  /** Present when the input has chapters: how many, and where the container's timeline starts (negative for an encoder-delay audio track). */
  chapters?: { count: number; startTimeSec: number };
}

/**
 * What the stream mapping of a conversion needs to know about `filePath`. A plain MP4 answers from its movie box
 * without a process; every other input, and every MP4 the header reader cannot describe exactly, is probed with
 * ffprobe once (the probe is remembered for the file, so the rest of the conversion reads it again at no cost).
 */
export function probeStreamLayout(filePath: string, ffprobe: FfprobePath): StreamLayout {
  const identity = fileIdentity(filePath);
  if (identity === undefined || !probeCache.has(identity)) {
    const header = readMp4Layout(filePath);
    if (header !== null) return { streams: header.streams };
  }
  const probe = probeInput(filePath, ffprobe);
  const { chapterCount, startTimeSec } = probe.timeline;
  return chapterCount > 0 ? { streams: probe.streams, chapters: { count: chapterCount, startTimeSec } } : { streams: probe.streams };
}

/** Transfer characteristic of the first video stream in `layout` (e.g. `bt709`, `smpte2084`), or '' when it states none. */
export function layoutColorTransfer(layout: StreamLayout): string {
  return layout.streams.find((stream) => stream.type === 'video')?.colorTransfer ?? '';
}

/** Every stream of the input, in index order. */
export function probeInputStreams(filePath: string, ffprobe: FfprobePath): InputStream[] {
  return probeInput(filePath, ffprobe).streams;
}

/** Start time and chapter count of the input. */
export function probeInputTimeline(filePath: string, ffprobe: FfprobePath): InputTimeline {
  return probeInput(filePath, ffprobe).timeline;
}

/** Transfer characteristic of the first video stream (e.g. `bt709`, `smpte2084`), or '' when it states none. */
export function probeVideoColorTransfer(filePath: string, ffprobe: FfprobePath): string {
  return probeInput(filePath, ffprobe).streams.find((stream) => stream.type === 'video')?.colorTransfer ?? '';
}

/** The first video stream that is a real video track, not cover art; undefined when the input has none. */
export function firstVideoStream<T extends LayoutStream>(streams: readonly T[]): T | undefined {
  return streams.find((stream) => stream.type === 'video' && !stream.attachedPicture);
}

/** Width and height as a player shows them: a quarter-turn display matrix swaps the stored sides. */
export function displayedSize(stream: InputStream): { width: number; height: number } | undefined {
  if (!stream.width || !stream.height) return undefined;
  const quarterTurn = Math.abs(stream.rotation) % HALF_TURN_DEGREES === QUARTER_TURN_DEGREES;
  return quarterTurn ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
}

export interface VideoGeometry {
  /** Frame rate as an exact rational (30000/1001 for 29.97 fps); never rounded to an integer. */
  fpsNum: number;
  fpsDen: number;
  /** Displayed width and height in pixels (after the display-matrix rotation). */
  width: number;
  height: number;
  durationSec: number;
  /** Video bit rate in kbit/s when the container states one. */
  bitrateK?: number;
}

/**
 * The frame rate to plan keyframes around. The base rate (`r_frame_rate`) is exact for constant-rate
 * input; for variable-rate input it is a timebase artefact, so the average rate is used instead.
 */
function planningFrameRate(stream: InputStream): { num: number; den: number } | undefined {
  const base = stream.frameRate;
  const average = stream.averageFrameRate;
  if (base && average && Math.abs(base.num / base.den - average.num / average.den) > (base.num / base.den) * VFR_RATE_TOLERANCE) {
    return average;
  }
  return base ?? average;
}

/** Duration of the input container in seconds, from ffprobe; throws when it cannot be read. */
export function probeInputDuration(filePath: string, ffprobe: FfprobePath): number {
  const out = runFfprobe(ffprobe, filePath, ['-show_entries', 'format=duration']);
  const parsed = Number.parseFloat(out);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MediaProbeError(`ffprobe reported an invalid duration: "${out}"`);
  }
  return parsed;
}

/**
 * Frame rate (exact rational), displayed size and duration of the first video stream. A file without a
 * video track throws NoVideoStreamError; a stream whose rate or size cannot be read throws MediaProbeError.
 */
export function probeVideoGeometry(filePath: string, ffprobe: FfprobePath): VideoGeometry {
  const stream = firstVideoStream(probeInputStreams(filePath, ffprobe));
  if (!stream) {
    throw new NoVideoStreamError('The input has no video stream, so it cannot be packaged for streaming.');
  }
  const size = displayedSize(stream);
  const rate = planningFrameRate(stream);
  if (!size || !rate) {
    throw new MediaProbeError('ffprobe could not read the frame rate and size of the input video stream.');
  }
  return {
    fpsNum: rate.num,
    fpsDen: rate.den,
    width: size.width,
    height: size.height,
    durationSec: probeInputDuration(filePath, ffprobe),
    bitrateK: stream.bitRateK,
  };
}
