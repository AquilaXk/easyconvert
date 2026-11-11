import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { ConversionFailedError, EngineUnavailableError, PayloadLimitError, SERVER_FAULT_STATUS } from '../types';
import type { ChromaSubsampling } from './image-encoder-defaults';

/**
 * JPEG written by `cjpegli`, the command-line encoder of jpegli (the libjpeg-compatible encoder of the JPEG XL project, BSD-3-Clause), run
 * as an external executable under the process sandbox (docs/policy-decisions.md, entry 231). The caller prepares the pixels
 * (orientation, resize, colour handling) and hands the 8-bit samples over as a binary PNM stream on the program's standard input, which has
 * no header worth parsing and no compression to pay for; the JPEG comes back on the standard output. No file is written, and the program
 * is started before the samples exist (`startJpegli`), so the start of the sandbox overlaps the decode of the picture. The encoder writes
 * no EXIF, XMP or JFIF segment and the caller splices the segments of its own metadata policy in (`withMetadataSegments`).
 *
 * Without the executable the caller keeps using the image library's JPEG encoder; an executable that is present and fails is an error,
 * never a reason to answer with the other encoder.
 */

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const CJPEGLI_PATH_ENV = 'CJPEGLI_PATH';
/**
 * Where the executable is looked for when `CJPEGLI_PATH` is not set. Only the build of `scripts/install-cjpegli.sh` is searched: another
 * build of the encoder (a distribution's, another release) writes other bytes for the same picture and quality, and the quality numbers of
 * the policy were measured on this one.
 */
export const CJPEGLI_CANDIDATES: readonly string[] = ['/usr/local/bin/cjpegli-pinned'];

/** Resident memory the sandbox allows one run before it kills the process group (polled by the sandbox, not an address-space cap). */
export const CJPEGLI_MEMORY_LIMIT_MB = 3072;
/** Address space (`RLIMIT_AS`, Linux) one run may map; it bounds runaway mappings, the resident-memory poller is the memory limit. */
export const CJPEGLI_ADDRESS_SPACE_MB = 6144;
/**
 * A run that has not finished in this time is stuck, not slow. The clock starts when the program starts, which is before the picture is
 * decoded (the program waits for its samples while the image library works), so the bound covers a slow decode of a large picture too.
 */
export const CJPEGLI_TIMEOUT_MS = 300_000;
/** Pictures with more pixels than this are encoded by the image library: the encoder holds the float planes and the coefficients of the whole picture. */
export const CJPEGLI_MAX_PIXELS = 64 * 1024 * 1024;
const CJPEGLI_DIAGNOSTIC_LOGGED_CHARS = 500;
const CJPEGLI_PROBE_TIMEOUT_MS = 10_000;
const CJPEGLI_PROBE_MAX_BYTES = 64 * 1024;
const BYTES_PER_MB = 1024 * 1024;
/** Exit statuses of a process that could not be started (not executable, not found). */
const NOT_EXECUTABLE_STATUS = 126;
const NOT_FOUND_STATUS = 127;
/** The tool reads the picture from its standard input and writes the JPEG to its standard output when a path is `-`. */
const STANDARD_STREAM = '-';

/** The range of `-q`; the encoder refuses anything else. */
const CJPEGLI_QUALITY_MIN = 1;
const CJPEGLI_QUALITY_MAX = 100;
/** The longest side the program takes: libjpeg's `JPEG_MAX_DIMENSION`, which jpegli enforces (`lib/jpegli/encode.cc`: "Input image too big"), a little under the 65,535 a frame header can state. */
export const JPEG_MAX_SIDE_PX = 65_500;
/**
 * The JPEG is read from the standard output, so its size bounds the output buffer. A JPEG of 8-bit samples is smaller than the samples in any
 * case the encoder can write (quality 100, noise); the bound is the samples of the largest picture the program takes, with tables.
 */
const CJPEGLI_MAX_OUTPUT_BYTES = CJPEGLI_MAX_PIXELS * 3 + 256 * 1024;

export type JpegliProgressiveLevel = 0 | 1 | 2;

export interface JpegliSettings {
  quality: number;
  /** Chroma subsampling of a colour picture; a grey picture has none. */
  chroma: ChromaSubsampling;
  /** 0 writes a sequential scan with optimised Huffman tables, 1 and 2 progressive scans (2 is the encoder's default). */
  progressive: JpegliProgressiveLevel;
  /** The picture has one channel (a grey source): the program is told no chroma subsampling, and `JpegliRun.send` takes one-channel samples. */
  grey: boolean;
  /** Aborting kills the encoder's process group, as `JpegliRun.cancel` does. */
  signal?: AbortSignal;
}

/** The samples of the picture: 8 bits, rows packed without padding, one channel (grey) or three (RGB). */
export interface JpegliSamples {
  pixels: Buffer;
  width: number;
  height: number;
  channels: number;
}

/** The encoder ran and exited with a failure it blames on the picture or an argument: a 400. */
export class JpegliEncoderFailedError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'JpegliEncoderFailedError';
  }
}

/** The encoder ended on a signal, or exited with a diagnostic that names neither the picture nor an argument: a fault of the program, 500. */
export class JpegliEncoderFaultError extends JpegliEncoderFailedError {
  readonly status = SERVER_FAULT_STATUS;

  constructor(message: string) {
    super(message);
    this.name = 'JpegliEncoderFaultError';
  }
}

/** True for the path of a regular file this process may execute. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Values of `CJPEGLI_PATH` and tools already reported as unusable, so each is reported once. */
const reportedUnusable = new Set<string>();

function reportOnce(key: string, message: string): void {
  if (reportedUnusable.has(key)) return;
  reportedUnusable.add(key);
  console.warn(`[jpegli] ${message}`);
}

/**
 * Whether a program's help text is the one of a `cjpegli` that accepts every option this module passes (`--quiet` is listed only in the
 * verbose help). The tool has no version flag; the options are the contract, and an older or different program that lacks one of them
 * would fail every picture.
 */
export function isSupportedHelp(help: string): boolean {
  return /\bINPUT OUTPUT\b/.test(help) && ['--quality', '--chroma_subsampling', '--progressive_level', '--quiet'].every((option) => help.includes(option));
}

/** What is known about a tool, by path, size and modification time; a probe that failed to run (timeout, killed) is asked again after `CJPEGLI_PROBE_RETRY_MS`. */
interface ProbeState {
  verdict?: boolean;
  failedAt?: number;
  pending?: Promise<boolean>;
}
const probes = new Map<string, ProbeState>();
export const CJPEGLI_PROBE_RETRY_MS = 60_000;

async function probeHelp(cjpegli: string, key: string, state: ProbeState, timeoutMs: number): Promise<boolean> {
  try {
    const result = await executeSandboxedBinary(cjpegli, ['-v', '-h'], { timeoutMs, maxBuffer: CJPEGLI_PROBE_MAX_BYTES, networkIsolated: true });
    state.verdict = isSupportedHelp(result.stdout.toString('utf-8') + result.stderr);
    if (!state.verdict) reportOnce(key, `${cjpegli} is not a cjpegli that takes the options this build passes, so the image library encodes JPEG`);
    return state.verdict;
  } catch (err) {
    rethrowSandboxUnavailable(err);
    state.failedAt = Date.now();
    console.warn(`[jpegli] ${cjpegli} could not print its help; the image library encodes JPEG and the tool is asked again in ${CJPEGLI_PROBE_RETRY_MS / 1000} s`);
    return false;
  } finally {
    state.pending = undefined;
  }
}

async function acceptsOptions(cjpegli: string, probeTimeoutMs: number): Promise<boolean> {
  const stat = fs.statSync(cjpegli);
  const key = `${cjpegli}|${stat.size}|${stat.mtimeMs}`;
  let state = probes.get(key);
  if (state === undefined) {
    state = {};
    probes.set(key, state);
  }
  if (state.verdict !== undefined) return state.verdict;
  if (state.pending !== undefined) return state.pending;
  if (state.failedAt !== undefined && Date.now() - state.failedAt < CJPEGLI_PROBE_RETRY_MS) return false;
  state.pending = probeHelp(cjpegli, key, state, probeTimeoutMs);
  return state.pending;
}

/**
 * Where a usable encoder is installed, or null. The environment is read on every call; the tool is run only to print its help, once. A
 * value of `CJPEGLI_PATH` is authoritative and must be the absolute path of an executable regular file; one that is not means the image
 * library encodes, and is logged once because the operator asked for something else.
 */
export async function findCjpegli(env: Readonly<Record<string, string | undefined>> = process.env, probeTimeoutMs: number = CJPEGLI_PROBE_TIMEOUT_MS): Promise<string | null> {
  const override = env[CJPEGLI_PATH_ENV];
  if (override !== undefined && override !== '') {
    if (path.isAbsolute(override) && isExecutableFile(override)) return (await acceptsOptions(override, probeTimeoutMs)) ? override : null;
    reportOnce(override, `${CJPEGLI_PATH_ENV} is set but is not the absolute path of an executable file; the image library encodes JPEG`);
    return null;
  }
  for (const candidate of CJPEGLI_CANDIDATES) {
    if (isExecutableFile(candidate) && (await acceptsOptions(candidate, probeTimeoutMs))) return candidate;
  }
  return null;
}

/** Whether a picture of this size is encoded by the program: within the pixel bound and the side bound of libjpeg. */
export function jpegliFits(width: number, height: number): boolean {
  return width <= JPEG_MAX_SIDE_PX && height <= JPEG_MAX_SIDE_PX && width * height <= CJPEGLI_MAX_PIXELS;
}

/** The header of a binary PNM stream: `P5` (grey) or `P6` (RGB), the size and the largest sample value. */
export function pnmHeaderOf(width: number, height: number, channels: 1 | 3): Buffer {
  return Buffer.from(`${channels === 1 ? 'P5' : 'P6'}\n${width} ${height}\n255\n`, 'latin1');
}

/** Arguments of one encode: the picture on the standard input, the JPEG on the standard output. */
export function cjpegliArguments(settings: Pick<JpegliSettings, 'quality' | 'chroma' | 'progressive' | 'grey'>): string[] {
  if (!Number.isInteger(settings.quality) || settings.quality < CJPEGLI_QUALITY_MIN || settings.quality > CJPEGLI_QUALITY_MAX) {
    throw new ConversionFailedError(`Cannot encode the image as .jpg (the quality must be a whole number from ${CJPEGLI_QUALITY_MIN} to ${CJPEGLI_QUALITY_MAX})`);
  }
  const args = [STANDARD_STREAM, STANDARD_STREAM, '--quiet', '-q', String(settings.quality), '-p', String(settings.progressive)];
  if (!settings.grey) args.push('--chroma_subsampling', settings.chroma === '4:4:4' ? '444' : '420');
  return args;
}

/** What `cjpegli` prints when it refuses the picture or an argument. */
const REFUSAL_DIAGNOSTIC = /invalid|failed to decode|unsupported|encoding failed/i;

function describeFailure(err: unknown, timeoutMs: number): Error {
  rethrowSandboxUnavailable(err);
  if (err instanceof SandboxedTimeoutError) {
    return new ConversionFailedError(`Cannot encode the image as .jpg (the encoder did not finish within ${timeoutMs} ms)`);
  }
  if (err instanceof SandboxedMemoryLimitError || err instanceof SandboxedBufferLimitError) {
    return new PayloadLimitError('Cannot encode the image as .jpg: it needs more memory or output than JPEG encoding allows');
  }
  if (err instanceof SandboxedProcessError) {
    if (err.exitCode === NOT_EXECUTABLE_STATUS || err.exitCode === NOT_FOUND_STATUS) {
      return new EngineUnavailableError('cjpegli', 'the executable cannot be started');
    }
    console.warn(`[jpegli] cjpegli failed with status ${String(err.exitCode)}: ${err.stderr.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, CJPEGLI_DIAGNOSTIC_LOGGED_CHARS)}`);
    const message = 'Cannot encode the image as .jpg (the JPEG encoder failed on the picture)';
    return err.signal === null && REFUSAL_DIAGNOSTIC.test(err.stderr) ? new JpegliEncoderFailedError(message) : new JpegliEncoderFaultError(message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Whether the bytes are a JPEG stream: they start with SOI and a marker and end with EOI. */
function looksLikeJpeg(data: Buffer): boolean {
  return data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
}

/** An encode that has started: the samples go in with `send`, the JPEG comes out of `result`, and `cancel` stops the program. */
export interface JpegliRun {
  /** Hands the samples to the program; once only. Samples that are not those the run was started for reject `result`. */
  send: (samples: JpegliSamples) => void;
  /** The JPEG file without EXIF, XMP, JFIF or profile segments, or the error of the run. */
  result: Promise<Buffer>;
  /** Kills the program's process group and settles once `result` has; a run already finished is left as it is. */
  cancel: () => Promise<void>;
}

/**
 * Starts the encoder at `cjpegli`, which then waits for its samples on the standard input; the caller decodes the picture meanwhile. The
 * run must end in `send` or in `cancel`: a program that is neither fed nor cancelled is killed by the time limit.
 */
export function startJpegli(cjpegli: string, settings: JpegliSettings): JpegliRun {
  const args = cjpegliArguments(settings);
  const stop = new AbortController();
  const signal = settings.signal ? AbortSignal.any([settings.signal, stop.signal]) : stop.signal;
  const input = new PassThrough();
  const channelsExpected = settings.grey ? 1 : 3;
  const result = executeSandboxedBinary(cjpegli, args, {
    timeoutMs: CJPEGLI_TIMEOUT_MS,
    maxBuffer: CJPEGLI_MAX_OUTPUT_BYTES,
    maxFileSize: CJPEGLI_MAX_OUTPUT_BYTES,
    memoryLimitMb: CJPEGLI_MEMORY_LIMIT_MB,
    rlimits: { asBytes: CJPEGLI_ADDRESS_SPACE_MB * BYTES_PER_MB },
    networkIsolated: true,
    spoolStdout: true,
    stdin: input,
    signal,
  }).then(
    (run) => {
      if (!looksLikeJpeg(run.stdout)) throw new ConversionFailedError('Cannot encode the image as .jpg (the JPEG encoder produced no JPEG file)');
      return run.stdout;
    },
    (err: unknown) => {
      throw describeFailure(err, CJPEGLI_TIMEOUT_MS);
    }
  );
  // A caller that cancels never looks at the result: the rejection is theirs to read or to ignore.
  const ended = result.then(
    () => undefined,
    () => undefined
  );
  let sent = false;
  return {
    send: (samples) => {
      if (sent) return;
      sent = true;
      const { pixels, width, height, channels } = samples;
      if (channels !== channelsExpected || pixels.length !== width * height * channels || !jpegliFits(width, height)) {
        input.destroy();
        stop.abort(new ConversionFailedError('Cannot encode the image as .jpg (the samples do not match the picture the encoder was started for)'));
        return;
      }
      input.write(pnmHeaderOf(width, height, channels as 1 | 3));
      input.end(pixels);
    },
    result,
    cancel: () => {
      input.destroy();
      stop.abort();
      return ended;
    },
  };
}

const MARKER_PREFIX = 0xff;
const MARKER_SOS = 0xda;
const MARKER_COM = 0xfe;
const MARKER_APP_FIRST = 0xe0;
const MARKER_APP_LAST = 0xef;
const SEGMENT_HEADER_BYTES = 4;
const SOI_BYTES = 2;

/** Offset of the first byte that is not an application or comment segment, from the start of the file: where the tables and the frame start. */
function endOfLeadingSegments(jpeg: Buffer): number {
  let at = SOI_BYTES;
  while (at + SEGMENT_HEADER_BYTES <= jpeg.length && jpeg[at] === MARKER_PREFIX) {
    const marker = jpeg[at + 1];
    if (marker === MARKER_SOS) break;
    const isLeading = marker === MARKER_COM || (marker >= MARKER_APP_FIRST && marker <= MARKER_APP_LAST);
    if (!isLeading) break;
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  return at;
}

/**
 * The JPEG `encoded` with the application and comment segments of `template` in place of its own (it has none from the program): SOI, the
 * template's JFIF, EXIF, XMP and profile segments in their order, then the tables, frame and scans of `encoded`. The template is a
 * JPEG the image library wrote from the same pipeline, so the metadata is what that encoder would have written.
 */
export function withMetadataSegments(encoded: Buffer, template: Buffer): Buffer {
  if (!looksLikeJpeg(template) || !looksLikeJpeg(encoded)) throw new ConversionFailedError('Cannot encode the image as .jpg (the metadata of the picture could not be attached)');
  const segments = template.subarray(SOI_BYTES, endOfLeadingSegments(template));
  return Buffer.concat([encoded.subarray(0, SOI_BYTES), segments, encoded.subarray(endOfLeadingSegments(encoded))]);
}
