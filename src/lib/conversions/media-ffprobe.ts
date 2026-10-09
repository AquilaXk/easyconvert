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
 * Throws when ffprobe cannot read the file instead of reporting a silent input. A WAVE file with uncompressed
 * samples answers from its header, without a process.
 */
export function probeAudioChannels(filePath: string, ffprobe: FfprobePath, streamIndex = 0): number {
  const wav = readWavPcmInfo(filePath);
  if (wav !== null) return streamIndex === 0 ? wav.channels : 0;
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

/**
 * Sample rate in Hz of the selected audio stream (the first by default), or 0 when it has none. A WAVE file with
 * uncompressed samples answers from its header, without a process.
 */
export function probeAudioSampleRate(filePath: string, ffprobe: FfprobePath, streamIndex = 0): number {
  const wav = readWavPcmInfo(filePath);
  if (wav !== null) return streamIndex === 0 ? wav.sampleRate : 0;
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

/** Transfer characteristic of the first video stream (e.g. `bt709`, `smpte2084`), or '' when unknown. */
export function probeVideoColorTransfer(filePath: string, ffprobe: FfprobePath): string {
  return runFfprobe(ffprobe, filePath, ['-select_streams', 'v:0', '-show_entries', 'stream=color_transfer']);
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
  };
}

/**
 * Every stream of the input, in index order. More than MAX_MAPPED_STREAMS throws TooManyMediaStreamsError,
 * so no later step lists or maps an unbounded number of streams.
 */
export function probeInputStreams(filePath: string, ffprobe: FfprobePath): InputStream[] {
  let stdout: string;
  try {
    stdout = execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', filePath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FFPROBE_TIMEOUT_MS,
      maxBuffer: MAX_FFPROBE_JSON_BYTES,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConversionFailedError(`ffprobe could not inspect the input media: ${detail}`);
  }
  let parsed: { streams?: unknown };
  try {
    parsed = JSON.parse(stdout) as { streams?: unknown };
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
  return (parsed.streams as RawStream[]).map(toInputStream);
}

export interface InputTimeline {
  /** Start of the container's timeline in seconds: the earliest stream start, negative for an encoder-delay audio track. */
  startTimeSec: number;
  chapterCount: number;
}

/**
 * Start time and chapter count of the input. The chapter list is probed by id only, so a file with thousands of
 * chapters stays within the JSON limit; a larger report is not a media file.
 */
export function probeInputTimeline(filePath: string, ffprobe: FfprobePath): InputTimeline {
  let stdout: string;
  try {
    stdout = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=start_time:chapter=id', '-of', 'json', filePath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FFPROBE_TIMEOUT_MS,
      maxBuffer: MAX_FFPROBE_JSON_BYTES,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConversionFailedError(`ffprobe could not inspect the input media: ${detail}`);
  }
  let parsed: { format?: { start_time?: unknown }; chapters?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new MediaProbeError('ffprobe did not return valid JSON for the input media.');
  }
  const start = typeof parsed.format?.start_time === 'string' ? Number(parsed.format.start_time) : 0;
  return {
    startTimeSec: Number.isFinite(start) ? start : 0,
    chapterCount: Array.isArray(parsed.chapters) ? parsed.chapters.length : 0,
  };
}

/** The first video stream that is a real video track, not cover art; undefined when the input has none. */
export function firstVideoStream(streams: readonly InputStream[]): InputStream | undefined {
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
