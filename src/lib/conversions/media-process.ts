import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
 *
 * FFmpeg checks the whitelist after its probe has chosen (`avformat_open_input`, demux.c line 286), so a real file whose container is not the
 * one its name says needs that container in the list of its format. The extra demuxers each read one local file and are
 * chosen by their own `read_probe` (FFmpeg 9.0.2): `argo_asf` (argo_asf.c, tag "ASF\0") under `.asf`, `aiff` (aiffdec.c,
 * "FORM" with "AIFF" or "AIFC") under `.caf`, `ea` (electronicarts.c, among them the tag "MPCh") under `.mpc`, `lmlm4`
 * (lmlm4.c) under `.divx` and `.xvid`, and `mpegts` (mpegts.c) under `.mpg` and `.mpeg`. Each is the container of a real
 * file of the FFmpeg test suite or samples that was refused without it (tests/media-container-named-otherwise.test.ts).
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
  asf: ['asf', 'argo_asf'],
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
  caf: ['caf', 'aiff'],
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
  mpc: ['mpc', 'mpc8', 'ea'],
  dss: ['dss'],
  avi: ['avi'],
  divx: ['avi', 'lmlm4'],
  xvid: ['avi', 'lmlm4'],
  flv: ['flv'],
  ts: ['mpegts'],
  mts: ['mpegts'],
  m2ts: ['mpegts'],
  vob: ['mpeg'],
  mod: ['mpeg'],
  mpg: ['mpeg', 'mpegvideo', 'mpegts'],
  mpeg: ['mpeg', 'mpegvideo', 'mpegts'],
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

/**
 * Where FFmpeg's `read_probe` of a reference format looks. `start` compares the first bytes of the probe buffer (`strncmp`,
 * `memcmp`). `text` searches it with C string functions (`strstr`, `av_stristr`), which stop at the first NUL byte, so only
 * the text before it can match. A binary container has a NUL in its first bytes, so the manifest text a metadata tag holds
 * never makes FFmpeg probe it as a manifest. SDP's line walk also passes a NUL inside a line, but scores 50, below the probe
 * of every container whose file it could then match.
 */
type ProbeSignature = { at: 'start'; prefix: string } | { at: 'text'; matches: (text: string) => boolean };

export interface ReferenceInputFormat {
  /** What the input is taken for, as the refusal names it. */
  kind: string;
  /** The FFmpeg demuxers of this format. */
  demuxers: readonly string[];
  /** The test of FFmpeg's probe for the format; absent when FFmpeg picks it only by name or option. */
  signature?: ProbeSignature;
}

/**
 * FFmpeg demuxers that open other files or URLs, or render arbitrary bytes as a picture, as their sources in FFmpeg 9.0.2
 * define them. The signatures repeat the `read_probe` of each: hls.c `hls_probe` (#EXTM3U at the start), concatdec.c
 * `concat_probe`, dashdec.c `dash_probe` (`<MPD` and a DASH profile, any case), imfdec.c `imf_probe`, rtsp.c `sdp_probe` (a
 * line that starts `c=IN IP`), mpeg.c `vobsub_probe` (its 20-byte prefix) and bintext.c `xbin_probe`. FFmpeg picks the
 * others only by file name or by option: img2dec.c (file name patterns), tty.c (`read_probe` needs a text extension),
 * bintext.c (bin, adf, idf), lavfi (filter graphs, whose `movie` source opens files), avisynth and vapoursynth (scripts),
 * rtsp and rtp (network) and dvdvideo.
 */
export const REFERENCE_INPUT_FORMATS: readonly ReferenceInputFormat[] = [
  { kind: 'HLS playlist', demuxers: ['hls'], signature: { at: 'start', prefix: '#EXTM3U' } },
  { kind: 'concat list', demuxers: ['concat'], signature: { at: 'start', prefix: 'ffconcat version 1.0' } },
  {
    kind: 'DASH manifest',
    demuxers: ['dash'],
    signature: { at: 'text', matches: (text) => /<MPD/i.test(text) && /dash:profile|3GPP:PSS:profile:DASH1/i.test(text) },
  },
  {
    kind: 'IMF composition playlist',
    demuxers: ['imf'],
    signature: { at: 'text', matches: (text) => text.includes('<CompositionPlaylist') && text.includes('ContentTitle>') },
  },
  { kind: 'SDP session description', demuxers: ['sdp', 'rtp', 'rtsp'], signature: { at: 'text', matches: (text) => /^c=IN IP/m.test(text) } },
  { kind: 'VobSub index', demuxers: ['vobsub'], signature: { at: 'start', prefix: '# VobSub index file,' } },
  { kind: 'XBIN text picture', demuxers: ['xbin'], signature: { at: 'start', prefix: 'XBIN\x1a' } },
  { kind: 'image sequence', demuxers: ['image2'] },
  { kind: 'text picture', demuxers: ['tty', 'bin', 'adf', 'idf'] },
  { kind: 'filter graph', demuxers: ['lavfi'] },
  { kind: 'script', demuxers: ['avisynth', 'vapoursynth'] },
  { kind: 'DVD', demuxers: ['dvdvideo'] },
];

/** A UTF-8 byte order mark as the Latin-1 reading of the bytes shows it. */
const UTF8_BOM = /^\xEF\xBB\xBF/;
/**
 * The bytes FFmpeg's format probe reads at most: `formatprobesize`, whose default is PROBE_BUF_MAX (1 MiB) in
 * libavformat's options_table.h. A reference signature further into the file is never probed.
 */
const FORMAT_PROBE_BYTES = 1024 * 1024;
const NUL = 0;

/** What the probe of a reference format sees of a file: its first bytes, and the text before its first NUL. */
interface ProbeWindow {
  head: Buffer;
  text: string;
}

/**
 * Reads the first HEADER_WINDOW_BYTES of `filePath`, and more up to FORMAT_PROBE_BYTES only while no NUL has been read: the
 * text signatures end at the first NUL, which a binary container has in its first bytes. A missing file reads as empty.
 */
function readProbeWindow(filePath: string): ProbeWindow {
  if (!fs.existsSync(filePath)) return { head: Buffer.alloc(0), text: '' };
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    let nulAt = -1;
    while (nulAt < 0 && length < FORMAT_PROBE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(HEADER_WINDOW_BYTES, FORMAT_PROBE_BYTES - length));
      const read = fs.readSync(fd, chunk, 0, chunk.length, length);
      if (read === 0) break;
      const filled = chunk.subarray(0, read);
      const chunkNul = filled.indexOf(NUL);
      if (chunkNul >= 0) nulAt = length + chunkNul;
      chunks.push(filled);
      length += read;
    }
    const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
    const text = bytes.subarray(0, nulAt < 0 ? length : nulAt).toString('latin1').replace(UTF8_BOM, '');
    return { head: bytes.subarray(0, Math.min(length, HEADER_WINDOW_BYTES)), text };
  } finally {
    fs.closeSync(fd);
  }
}

/** A prefix holds no NUL, so it matches the text before the first NUL exactly when it matches the bytes. */
function probes(signature: ProbeSignature, text: string): boolean {
  return signature.at === 'start' ? text.startsWith(signature.prefix) : signature.matches(text);
}

declare const openedMediaInput: unique symbol;

/**
 * A media input whose reader is decided: the demuxers FFmpeg may open it with, from its bytes and the conversion's declared
 * source format. Only openMediaInput makes one, so every argument list and probe reads a file that passed the reference check.
 */
export interface MediaInput {
  readonly path: string;
  /** The conversion's declared source format (registry id). */
  readonly format: string;
  readonly demuxers: readonly string[];
  readonly [openedMediaInput]: true;
}

/**
 * Decides how `filePath` is read, from its bytes and the declared source `format` of the conversion (never the file's name:
 * a queued job reads `<sha256>.bin`). A file whose first bytes FFmpeg's probe would take for a reference format is refused,
 * whatever container it also looks like, because the `subtitles` filter of a burn opens the input again with FFmpeg's own
 * probe (vf_subtitles.c `avformat_open_input` with no format). Otherwise the container its signature shows is forced, or else
 * the demuxers of the declared format; a format without an entry is refused too.
 */
export function openMediaInput(filePath: string, format: string): MediaInput {
  const { head, text } = readProbeWindow(filePath);
  const reference = REFERENCE_INPUT_FORMATS.find((candidate) => candidate.signature !== undefined && probes(candidate.signature, text));
  if (reference !== undefined) {
    throw new RefusedMediaInputError(
      reference.kind,
      `The file is a ${reference.kind}, not a media file: it names other files or addresses for the reader to open, which a conversion never does.`
    );
  }
  const declared = format.toLowerCase();
  const sniffed = sniffMimeTypeFromMagicBytes(head);
  const container = sniffed !== undefined && Object.hasOwn(SNIFFED_CONTAINER_DEMUXERS, sniffed) ? SNIFFED_CONTAINER_DEMUXERS[sniffed] : undefined;
  if (container === undefined && !Object.hasOwn(MEDIA_INPUT_DEMUXERS, declared)) {
    throw new RefusedMediaInputError(declared, `There is no media reader a conversion may use for a .${declared} file.`);
  }
  const demuxers: readonly string[] = container === undefined ? MEDIA_INPUT_DEMUXERS[declared] : [container];
  return { path: filePath, format: declared, demuxers } as MediaInput;
}

/** `-i` with the options that pin how `input` is opened: the protocol whitelist and the demuxer choice. */
export function mediaInputArgs(input: MediaInput): string[] {
  const { demuxers } = input;
  const choice = demuxers.length === 1 ? ['-f', demuxers[0]] : ['-format_whitelist', demuxers.join(',')];
  return ['-protocol_whitelist', PROTOCOL_WHITELIST, ...choice, '-i', input.path];
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
      throw new Error(`ffmpeg and ffprobe must not run with ${arg} ALL.`);
    }
    if (arg !== '-i') return;
    const options = args.slice(inputStart, index);
    const whitelisted = options.some((option, at) => option === '-protocol_whitelist' && options[at + 1] === PROTOCOL_WHITELIST);
    if (!whitelisted || !options.some((option) => DEMUXER_CHOICES.has(option))) {
      throw new Error('An input without -protocol_whitelist file and a demuxer choice; build it with mediaInputArgs.');
    }
    inputStart = index + 2;
  });
}

/** The options of an ffmpeg run; the network namespace is not one, because every run gets it. */
export type FfmpegRunOptions = Omit<SandboxedExecutionOptions, 'networkIsolated'>;

/** Runs ffmpeg in the sandbox (network namespace, sanitized environment) with guarded inputs. */
export async function runFfmpeg(ffmpegBin: string, args: string[], options: FfmpegRunOptions): Promise<SandboxedExecutionResult> {
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

/** Runs ffprobe over `input` in the sandbox, with `args` before the input and the input opened as mediaInputArgs opens it. */
export function runFfprobe(ffprobe: string, args: readonly string[], input: MediaInput, limits: ToolLimits): ToolRun {
  const probeArgs = [...args, ...mediaInputArgs(input)];
  assertGuardedInputs(probeArgs);
  return runSandboxedSync(ffprobe, probeArgs, limits);
}

const FFMPEG_VERSION_TIMEOUT_MS = 3000;
const FFMPEG_VERSION_MAX_BYTES = 64 * 1024;
const FFMPEG_VERSION_LINE = /^(?:ffmpeg|ffprobe) version n?(\d+)\.(\d+)(?:\.(\d+))?/m;
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
  /** Why `-version` did not run (a missing binary, a crash); undefined when it ran. */
  runFailure: string | undefined;
}

const buildCache = new Map<string, FfmpegBuildFacts>();

/** What `-version` of an ffmpeg or ffprobe binary says about the build. The probe runs once per binary. */
export function probeFfmpegBuild(ffmpegBin: string): FfmpegBuildFacts {
  const cached = buildCache.get(ffmpegBin);
  if (cached !== undefined) return cached;
  const run = runFfmpegSync(ffmpegBin, ['-hide_banner', '-version'], { timeoutMs: FFMPEG_VERSION_TIMEOUT_MS, maxBuffer: FFMPEG_VERSION_MAX_BYTES });
  const release = run.ok ? FFMPEG_VERSION_LINE.exec(run.stdout) : null;
  const facts: FfmpegBuildFacts = {
    soxr: run.ok && run.stdout.includes(SOXR_FEATURE_FLAG),
    version: release ? { major: Number(release[1]), minor: Number(release[2]), patch: Number(release[3] ?? 0) } : undefined,
    runFailure: run.ok ? undefined : run.failure,
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

function describeBuild({ version, runFailure }: FfmpegBuildFacts): string {
  if (runFailure !== undefined) return `could not be run (${runFailure})`;
  return version === undefined ? 'is a development build or an unreadable version' : `is release ${versionText(version)}`;
}

/** Why the ffmpeg or ffprobe `binary` is not fit to serve, or undefined when its release is MIN_FFMPEG_VERSION or later. */
export function ffmpegVersionProblem(binary: string): string | undefined {
  const build = probeFfmpegBuild(binary);
  if (build.version !== undefined && atLeast(build.version, MIN_FFMPEG_VERSION)) return undefined;
  return `FFmpeg ${versionText(MIN_FFMPEG_VERSION)} or later is required, and ${binary} ${describeBuild(build)}.`;
}

/**
 * The start-up check of the installed ffmpeg and of the ffprobe that reads every upload before it. Under STRICT_SANDBOX an
 * older or unknown release, a binary that cannot run, and a missing ffprobe stop the process; elsewhere (a development host
 * with its distribution's FFmpeg) they are logged and the process starts.
 */
export function enforceFfmpegMinimumVersion(ffmpegBin: string | null, ffprobeBin: string | null): void {
  if (ffmpegBin === null) return;
  const ffprobeProblem = ffprobeBin === null ? `No ffprobe was found for ${ffmpegBin}.` : ffmpegVersionProblem(ffprobeBin);
  const problems = [ffmpegVersionProblem(ffmpegBin), ffprobeProblem].filter((problem) => problem !== undefined);
  if (problems.length === 0) return;
  const problem = problems.join(' ');
  if (process.env.STRICT_SANDBOX === 'true') throw new EngineUnavailableError('ffmpeg', problem);
  console.warn(`[EasyConvert] ${problem}`);
}
