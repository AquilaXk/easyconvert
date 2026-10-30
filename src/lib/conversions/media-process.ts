import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HEADER_WINDOW_BYTES } from '../format-signatures';
import { sniffMimeTypeFromMagicBytes } from '../registry';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  resolveSandboxedCommand,
  type SandboxedExecutionOptions,
  type SandboxedExecutionResult,
} from '../security/process-sandbox';
import { EngineUnavailableError, RefusedMediaInputError } from '../types';

/**
 * The one place that starts ffmpeg and ffprobe. Every process runs in the namespace sandbox, and every input it opens gets
 * `-protocol_whitelist file` and the demuxer of its detected format, so an upload can never make FFmpeg pick a demuxer that
 * opens other files or URLs (HLS, concat, DASH and the rest of REFERENCE_INPUT_FORMATS).
 */

const PROTOCOL_WHITELIST = 'file';

/**
 * The FFmpeg demuxers each media source format may be read with, by registry id (the audio and video formats, the animated
 * images the registry converts to video, and the subtitle files a conversion adds). One name is forced with `-f`; several (a
 * format whose files come in more than one container or bitstream) are passed as `-format_whitelist`, and FFmpeg's own probe
 * picks among them. No entry names a demuxer of REFERENCE_INPUT_FORMATS.
 */
export const MEDIA_INPUT_DEMUXERS: Readonly<Record<string, readonly string[]>> = {
  mp3: ['mp3'],
  wav: ['wav'],
  aac: ['aac'],
  flac: ['flac'],
  ogg: ['ogg'],
  oga: ['ogg'],
  ogv: ['ogg'],
  opus: ['ogg'],
  spx: ['ogg'],
  wma: ['asf'],
  wmv: ['asf'],
  asf: ['asf'],
  dvr: ['asf', 'mpeg'],
  m4a: ['mov'],
  m4b: ['mov'],
  mp4: ['mov'],
  mov: ['mov'],
  '3gp': ['mov'],
  '3gpp': ['mov'],
  '3g2': ['mov'],
  f4v: ['mov'],
  m4v: ['mov', 'm4v'],
  alac: ['mov', 'caf'],
  aiff: ['aiff'],
  aif: ['aiff'],
  aifc: ['aiff'],
  amr: ['amr', 'amrnb', 'amrwb'],
  au: ['au'],
  caf: ['caf'],
  dts: ['dts', 'dtshd'],
  ac3: ['ac3', 'eac3'],
  mka: ['matroska'],
  mkv: ['matroska'],
  webm: ['matroska'],
  weba: ['matroska'],
  ra: ['rm'],
  rm: ['rm'],
  rmvb: ['rm'],
  voc: ['voc'],
  ape: ['ape'],
  mpc: ['mpc', 'mpc8'],
  dss: ['dss'],
  avi: ['avi'],
  divx: ['avi'],
  xvid: ['avi'],
  flv: ['flv'],
  ts: ['mpegts'],
  mts: ['mpegts'],
  m2ts: ['mpegts'],
  vob: ['mpeg'],
  mod: ['mpeg'],
  mpg: ['mpeg', 'mpegvideo'],
  mpeg: ['mpeg', 'mpegvideo'],
  m2v: ['mpegvideo'],
  h264: ['h264'],
  h265: ['hevc'],
  hevc: ['hevc'],
  av1: ['obu', 'ivf', 'av1'],
  cavs: ['cavsvideo'],
  dv: ['dv'],
  mxf: ['mxf'],
  swf: ['swf'],
  wtv: ['wtv'],
  webpvideo: ['webp_anim', 'webp_pipe'],
  gif: ['gif'],
  webp: ['webp_anim', 'webp_pipe'],
  srt: ['srt'],
  ass: ['ass'],
  ssa: ['ass'],
  vtt: ['webvtt'],
};

/** The demuxer of a container whose signature the upload check sniffs; it decides over the declared format. */
const SNIFFED_CONTAINER_DEMUXERS: Readonly<Record<string, string>> = {
  'video/mp4': 'mov',
  'audio/mp4': 'mov',
  'video/webm': 'matroska',
  'video/x-matroska': 'matroska',
  'audio/x-matroska': 'matroska',
  'video/x-msvideo': 'avi',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
};

export interface ReferenceInputFormat {
  /** What the input is taken for, as the refusal names it. */
  kind: string;
  /** The FFmpeg demuxers of this format. */
  demuxers: readonly string[];
  /** The test of FFmpeg's probe for the format, over the first bytes as Latin-1; absent when FFmpeg picks it only by name or option. */
  signature?: (head: string) => boolean;
}

/**
 * FFmpeg demuxers that open other files or URLs, or render arbitrary bytes as a picture, as their sources in FFmpeg 9.0.2
 * define them. The signatures repeat the `read_probe` of each: hls.c `hls_probe` (#EXTM3U at the start), concatdec.c
 * `concat_probe`, dashdec.c `dash_probe` (`<MPD` and a DASH profile, any case), imfdec.c `imf_probe`, rtsp.c `sdp_probe` (a
 * line that starts `c=IN IP`), mpeg.c `vobsub_probe` and bintext.c `xbin_probe`. FFmpeg picks the others only by file name or by option:
 * img2dec.c (file name patterns), tty.c (`read_probe` needs a text extension), bintext.c (bin, adf, idf), lavfi (filter
 * graphs, whose `movie` source opens files), avisynth and vapoursynth (scripts), rtsp and rtp (network) and dvdvideo.
 */
export const REFERENCE_INPUT_FORMATS: readonly ReferenceInputFormat[] = [
  { kind: 'HLS playlist', demuxers: ['hls'], signature: (head) => head.startsWith('#EXTM3U') },
  { kind: 'concat list', demuxers: ['concat'], signature: (head) => head.startsWith('ffconcat version 1.0') },
  { kind: 'DASH manifest', demuxers: ['dash'], signature: (head) => /<MPD/i.test(head) && /dash:profile|3GPP:PSS:profile:DASH1/i.test(head) },
  { kind: 'IMF composition playlist', demuxers: ['imf'], signature: (head) => head.includes('<CompositionPlaylist') && head.includes('ContentTitle>') },
  { kind: 'SDP session description', demuxers: ['sdp', 'rtp', 'rtsp'], signature: (head) => /^c=IN IP/m.test(head) },
  { kind: 'VobSub index', demuxers: ['vobsub'], signature: (head) => head.startsWith('# VobSub index file, v') },
  { kind: 'XBIN text picture', demuxers: ['xbin'], signature: (head) => head.startsWith('XBIN\x1a') },
  { kind: 'image sequence', demuxers: ['image2'] },
  { kind: 'text picture', demuxers: ['tty', 'bin', 'adf', 'idf'] },
  { kind: 'filter graph', demuxers: ['lavfi'] },
  { kind: 'script', demuxers: ['avisynth', 'vapoursynth'] },
  { kind: 'DVD', demuxers: ['dvdvideo'] },
];

/** A UTF-8 byte order mark as the Latin-1 reading of the head shows it. */
const UTF8_BOM = /^ï»¿/;

function readHead(filePath: string): Buffer {
  if (!fs.existsSync(filePath)) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(HEADER_WINDOW_BYTES);
    return head.subarray(0, fs.readSync(fd, head, 0, HEADER_WINDOW_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The demuxers `filePath` may be read with: the container its signature shows, or else the one of its declared format. Every
 * conversion writes its input as `<name>.<source format>`, so the extension is the declared format the upload check compared
 * with the bytes; the client's file name never reaches here. A file whose first bytes FFmpeg's probe would take for a reference
 * format is refused first, whatever container it also looks like: the `subtitles` filter of a burn opens the input again with
 * FFmpeg's own probe (vf_subtitles.c `avformat_open_input` with no format). A declared format without an entry is refused too.
 */
function inputDemuxers(filePath: string): readonly string[] {
  const head = readHead(filePath);
  const text = head.toString('latin1').replace(UTF8_BOM, '');
  const reference = REFERENCE_INPUT_FORMATS.find((format) => format.signature?.(text));
  if (reference !== undefined) {
    throw new RefusedMediaInputError(
      reference.kind,
      `The file is a ${reference.kind}, not a media file: it names other files or addresses for the reader to open, which a conversion never does.`
    );
  }
  const sniffed = sniffMimeTypeFromMagicBytes(head);
  if (sniffed !== undefined && Object.hasOwn(SNIFFED_CONTAINER_DEMUXERS, sniffed)) return [SNIFFED_CONTAINER_DEMUXERS[sniffed]];
  const declared = path.extname(filePath).slice(1).toLowerCase();
  if (!Object.hasOwn(MEDIA_INPUT_DEMUXERS, declared)) {
    throw new RefusedMediaInputError(declared, `There is no media reader a conversion may use for a .${declared} file.`);
  }
  return MEDIA_INPUT_DEMUXERS[declared];
}

/** The input options that pin how `filePath` is opened: the protocol whitelist and the demuxer choice. */
export function mediaInputOptions(filePath: string): string[] {
  const demuxers = inputDemuxers(filePath);
  const choice = demuxers.length === 1 ? ['-f', demuxers[0]] : ['-format_whitelist', demuxers.join(',')];
  return ['-protocol_whitelist', PROTOCOL_WHITELIST, ...choice];
}

/** `-i filePath` with the options that pin how it is opened. */
export function mediaInputArgs(filePath: string): string[] {
  return [...mediaInputOptions(filePath), '-i', filePath];
}

/** An input generated by a filter graph of our own (never one from a request). */
export function lavfiInputArgs(graph: string): string[] {
  return ['-protocol_whitelist', PROTOCOL_WHITELIST, '-f', 'lavfi', '-i', graph];
}

const DEMUXER_CHOICES: ReadonlySet<string> = new Set(['-f', '-format_whitelist']);
const OPEN_EXTENSION_OPTIONS: ReadonlySet<string> = new Set(['-allowed_extensions', '-allowed_segment_extensions']);

/** Throws unless every `-i` of `args` comes with `-protocol_whitelist file` and a demuxer choice, and no extension check is opened up. */
function assertGuardedInputs(args: readonly string[]): void {
  let inputStart = 0;
  args.forEach((arg, index) => {
    if (OPEN_EXTENSION_OPTIONS.has(arg) && args[index + 1] === 'ALL') {
      throw new Error(`ffmpeg must not run with ${arg} ALL.`);
    }
    if (arg !== '-i') return;
    const options = args.slice(inputStart, index);
    const whitelisted = options.some((option, at) => option === '-protocol_whitelist' && options[at + 1] === PROTOCOL_WHITELIST);
    if (!whitelisted || !options.some((option) => DEMUXER_CHOICES.has(option))) {
      throw new Error('ffmpeg input without -protocol_whitelist file and a demuxer choice; build it with mediaInputArgs.');
    }
    inputStart = index + 2;
  });
}

/** Runs ffmpeg in the sandbox (network namespace, sanitized environment) with guarded inputs. */
export async function runFfmpeg(
  ffmpegBin: string,
  args: string[],
  options: SandboxedExecutionOptions
): Promise<SandboxedExecutionResult> {
  assertGuardedInputs(args);
  return executeSandboxedBinary(ffmpegBin, args, { ...options, networkIsolated: true });
}

export interface ToolLimits {
  timeoutMs: number;
  maxBuffer: number;
}

/** The outcome of a synchronous run: its output, and why it failed when it did (a non-zero exit, a signal, a limit). */
export type ToolRun = { ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string; failure: string };

/**
 * Runs a tool synchronously in the sandbox. The sandbox is resolved before the spawn, so SandboxUnavailableError is thrown and
 * no process starts; every other failure is a value.
 */
function runSandboxedSync(binary: string, args: readonly string[], limits: ToolLimits): ToolRun {
  const command = resolveSandboxedCommand(binary, [...args], { networkIsolated: true });
  const run = spawnSync(command.binary, command.args, {
    encoding: 'utf-8',
    env: getSanitizedEnvironment({}, true),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxBuffer,
    killSignal: 'SIGKILL',
  });
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  if (run.error === undefined && run.status === 0) return { ok: true, stdout, stderr };
  const failure = run.error?.message ?? (run.signal !== null ? `killed by ${run.signal}` : `exited with status ${run.status}`);
  return { ok: false, stdout, stderr, failure: stderr.trim() || failure };
}

/** Runs ffmpeg synchronously in the sandbox, for the questions about the build (encoders, filters, version, a test encode). */
export function runFfmpegSync(ffmpegBin: string, args: readonly string[], limits: ToolLimits): ToolRun {
  assertGuardedInputs(args);
  return runSandboxedSync(ffmpegBin, args, limits);
}

/** Runs ffprobe over `filePath` in the sandbox, with `args` before the input and the input opened as mediaInputArgs opens it. */
export function runFfprobe(ffprobe: string, args: readonly string[], filePath: string, limits: ToolLimits): ToolRun {
  return runSandboxedSync(ffprobe, [...args, ...mediaInputArgs(filePath)], limits);
}

const FFMPEG_VERSION_TIMEOUT_MS = 3000;
const FFMPEG_VERSION_MAX_BYTES = 64 * 1024;
const FFMPEG_VERSION_LINE = /^ffmpeg version n?(\d+)\.(\d+)(?:\.(\d+))?/m;
const SOXR_FEATURE_FLAG = '--enable-libsoxr';

export interface FfmpegVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface FfmpegBuildFacts {
  soxr: boolean;
  /** Release number from the first line of `-version`; undefined for a development build (`N-123-g...`) or an unreadable answer. */
  version: FfmpegVersion | undefined;
}

const buildCache = new Map<string, FfmpegBuildFacts>();

/** What `ffmpeg -version` says about the build. The probe runs once per binary. */
export function probeFfmpegBuild(ffmpegBin: string): FfmpegBuildFacts {
  const cached = buildCache.get(ffmpegBin);
  if (cached !== undefined) return cached;
  const run = runFfmpegSync(ffmpegBin, ['-hide_banner', '-version'], { timeoutMs: FFMPEG_VERSION_TIMEOUT_MS, maxBuffer: FFMPEG_VERSION_MAX_BYTES });
  const release = run.ok ? FFMPEG_VERSION_LINE.exec(run.stdout) : null;
  const facts: FfmpegBuildFacts = {
    soxr: run.ok && run.stdout.includes(SOXR_FEATURE_FLAG),
    version: release ? { major: Number(release[1]), minor: Number(release[2]), patch: Number(release[3] ?? 0) } : undefined,
  };
  buildCache.set(ffmpegBin, facts);
  return facts;
}

/**
 * The oldest FFmpeg a server may run: releases before 8.1.3 open the child playlists of an HLS playlist without its protocol
 * and extension checks (CVE-2026-107697, fixed in 8.1.3 and in every 9.0 release).
 */
export const MIN_FFMPEG_VERSION: FfmpegVersion = { major: 8, minor: 1, patch: 3 };

function atLeast(version: FfmpegVersion, minimum: FfmpegVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

function versionText({ major, minor, patch }: FfmpegVersion): string {
  return `${major}.${minor}.${patch}`;
}

/** Why `ffmpegBin` is not fit to serve, or undefined when its release is MIN_FFMPEG_VERSION or later. */
export function ffmpegVersionProblem(ffmpegBin: string): string | undefined {
  const { version } = probeFfmpegBuild(ffmpegBin);
  if (version !== undefined && atLeast(version, MIN_FFMPEG_VERSION)) return undefined;
  const found = version === undefined ? 'a development build or an unreadable version' : `release ${versionText(version)}`;
  return `FFmpeg ${versionText(MIN_FFMPEG_VERSION)} or later is required, and ${ffmpegBin} is ${found}.`;
}

/**
 * The start-up check of the installed FFmpeg. Under STRICT_SANDBOX an older or unknown release stops the process; elsewhere
 * (a development host with its distribution's FFmpeg) it is logged and the process starts.
 */
export function enforceFfmpegMinimumVersion(ffmpegBin: string | null): void {
  if (ffmpegBin === null) return;
  const problem = ffmpegVersionProblem(ffmpegBin);
  if (problem === undefined) return;
  if (process.env.STRICT_SANDBOX === 'true') throw new EngineUnavailableError('ffmpeg', problem);
  console.warn(`[EasyConvert] ${problem}`);
}
