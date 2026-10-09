import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { ConversionFailedError, EngineUnavailableError, PayloadLimitError } from '../types';
import { isAvif } from './avif-colour';
import { avifSpeedFor, type AvifBitdepth, type AvifEncoder, type AvifPlaneLayout } from './image-encoder-defaults';

/**
 * AVIF written by the reference AVIF library's command-line encoder (`avifenc`, which drives the AV1 encoder), run
 * as an external executable under the process sandbox. The caller prepares the pixels (orientation, resize, colour
 * management) and hands them over as a PNG file: PNG keeps 8 or 16 bits per sample, one to four channels and the
 * EXIF block, and costs about 4 ms at compression level 1 where the encoder takes 25 to 100 ms. The PNG and the
 * encoder's output live in a private directory (mode 0700) that is removed afterwards.
 *
 * Without the executable the caller keeps using the image library (`AvifEncoder`); an executable that is present
 * and fails is an error, never a reason to answer with the other encoder.
 */

/** The encoder names reported in the result metadata (`avifEncoder`). */
export const AVIF_ENCODER_LIBRARY_CLI: AvifEncoder = 'library-cli';
export const AVIF_ENCODER_IMAGE_LIBRARY: AvifEncoder = 'image-library';

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const AVIFENC_PATH_ENV = 'AVIFENC_PATH';
const AVIFENC_CANDIDATES = ['/usr/bin/avifenc', '/usr/local/bin/avifenc', '/opt/homebrew/bin/avifenc'];

/** Resident memory the sandbox allows one run before it kills the process group (polled by the sandbox, not an address-space cap). */
export const AVIFENC_MEMORY_LIMIT_MB = 3072;
/**
 * Threads one run may use. The encoder splits the picture into tiles and rows, and a 12-megapixel 16-bit picture at
 * speed 6 encodes in 6.0 s on 1 thread, 1.7 s on 4, 1.0 s on 8 and 0.9 s on 12: beyond 8 threads a run gains about
 * 10% while every thread costs address space (see `AVIFENC_ADDRESS_SPACE_MB`) and takes cores from concurrent jobs.
 */
export const AVIFENC_MAX_THREADS = 8;
/**
 * Address space (`RLIMIT_AS`, Linux) one run may map. It bounds runaway mappings; the resident-memory poller is the
 * memory limit. Virtual size is larger than resident size: for the largest picture the tool is given (48 megapixels,
 * 16-bit RGB) the data is about 2.2 GB (45 bytes per pixel), each thread reserves its stack (8 MB) and an allocator
 * arena (64 MB), so 8 threads add about 0.6 GB, and the libraries and the encoder's tables about 0.25 GB: roughly
 * 3.1 GB. 5 GB leaves a margin of about 60% without letting a run map without bound.
 */
export const AVIFENC_ADDRESS_SPACE_MB = 5120;
/** A run that has not finished in this time is stuck, not slow: the slowest tier (a few megapixels at speed 4) takes under a minute. */
export const AVIFENC_TIMEOUT_MS = 180_000;
/** Diagnostics the encoder may print; more is runaway output. */
const AVIFENC_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
/** The file written is at most this many bytes per pixel (four 10-bit planes, lossless, uncompressible) plus headers. */
const AVIFENC_MAX_OUTPUT_BYTES_PER_PIXEL = 8;
const AVIFENC_OUTPUT_OVERHEAD_BYTES = 64 * 1024;
/** Characters of the encoder's diagnostics written to the log on a failure. */
const AVIFENC_DIAGNOSTIC_LOGGED_CHARS = 500;
const AVIFENC_JOB_DIR_PREFIX = 'easyconvert-avif-';
const AVIFENC_INPUT_NAME = 'in.png';
const AVIFENC_OUTPUT_NAME = 'out.avif';
const PRIVATE_FILE_MODE = 0o600;
const AVIFENC_CLEANUP_RETRIES = 3;
const AVIFENC_CLEANUP_RETRY_DELAY_MS = 50;
const BYTES_PER_MB = 1024 * 1024;
/** Exit statuses of a process that could not be started (not executable, not found). */
const NOT_EXECUTABLE_STATUS = 126;
const NOT_FOUND_STATUS = 127;

/** The range of `-q`; the encoder reads anything else as a different number or refuses it. */
const AVIFENC_QUALITY_MIN = 0;
const AVIFENC_QUALITY_MAX = 100;

/** The `-y` value of each plane layout. */
const YUV_FORMAT: Readonly<Record<AvifPlaneLayout, string>> = { '4:0:0': '400', '4:2:0': '420', '4:4:4': '444' };

/** Colour description written as the `colr` nclx box: primaries / transfer / matrix code points (ITU-T H.273). */
export interface AvifCicp {
  primaries: number;
  transfer: number;
  matrix: number;
}

export interface AvifCliRequest {
  /** The prepared picture as a PNG: 8 or 16 bits per sample; one (grey) or three colour channels, with or without alpha. */
  png: Buffer;
  width: number;
  height: number;
  quality: number;
  effort: number;
  bitdepth: AvifBitdepth;
  layout: AvifPlaneLayout;
  /** Tuning metric for the colour planes, or undefined for the encoder's own. */
  tune?: string;
  /** Colour tags to write instead of the encoder's defaults, for HDR output. */
  cicp?: AvifCicp;
  /** Aborting kills the encoder's process group; the private directory is removed as for any other failure. */
  signal?: AbortSignal;
}

/** Limits a caller may tighten; the defaults are the module's constants. */
export interface AvifCliLimits {
  timeoutMs?: number;
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

/**
 * Oldest libavif whose `avifenc` accepts every option this module passes. From the libavif changelog: 1.0.0 adds the
 * quality and qualityAlpha settings of the encoder and with them `-q` and `--qalpha` ("Add quality and qualityAlpha to
 * avifEncoder"); 0.11.1 has only the quantizer pair `--min`/`--max` and stops on `-q`. The other options are older:
 * `-j all` and `-j N` (0.9.2), `--cicp` as the alias of `--nclx` (the CICP refactor, 0.9 series), `-y`, `-d`, `-s`, `-o`
 * and `-a` with the `c:` prefix for colour-only codec options (present in 0.11.1 and 1.0.0). `-V`/`--version`, which
 * the probe uses, is in 1.0.0. The picture is a file argument, which every version reads. Debian 12 ships 0.11.1 (not
 * accepted); Debian 13 ships 1.2.1 and Ubuntu 24.04 1.0.4 (accepted). Anything older counts as "not installed".
 */
export const AVIFENC_MIN_VERSION: readonly [number, number, number] = [1, 0, 0];
const AVIFENC_PROBE_TIMEOUT_MS = 10_000;
const AVIFENC_PROBE_MAX_BYTES = 64 * 1024;

/** Values of `AVIFENC_PATH` and tools already reported as unusable, so each is reported once. */
const reportedUnusable = new Set<string>();

function reportOnce(key: string, message: string): void {
  if (reportedUnusable.has(key)) return;
  reportedUnusable.add(key);
  console.warn(`[avif] ${message}`);
}

/** Version a tool reports (`Version: 1.4.2 (...)`), or null when it reports none we can read. */
export function parseAvifencVersion(output: string): [number, number, number] | null {
  const match = /Version:\s*(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/**
 * What is known about a tool, by path, size and modification time. A version the tool printed is a definite answer and
 * is kept (it is asked once, not per picture). A probe that failed to run (timeout, spawn error, killed) says nothing
 * about the version: the tool counts as unavailable for `AVIFENC_PROBE_RETRY_MS` and is asked again after that.
 */
interface ProbeState {
  verdict?: boolean;
  failedAt?: number;
  pending?: Promise<boolean>;
}
const probes = new Map<string, ProbeState>();
/** How long a probe that failed to run keeps the tool out of use before it is tried again. */
export const AVIFENC_PROBE_RETRY_MS = 60_000;

async function probeVersion(avifenc: string, key: string, state: ProbeState, timeoutMs: number): Promise<boolean> {
  try {
    const result = await executeSandboxedBinary(avifenc, ['--version'], { timeoutMs, maxBuffer: AVIFENC_PROBE_MAX_BYTES, networkIsolated: true });
    const version = parseAvifencVersion(result.stdout.toString('utf-8'));
    state.verdict = version !== null && isAtLeast(version, AVIFENC_MIN_VERSION);
    if (!state.verdict) {
      reportOnce(key, `${avifenc} reports ${version === null ? 'no version' : `libavif ${version.join('.')}`}; libavif ${AVIFENC_MIN_VERSION.join('.')} or newer is needed, so the image library encodes AVIF`);
    }
    return state.verdict;
  } catch (err) {
    rethrowSandboxUnavailable(err);
    state.failedAt = Date.now();
    console.warn(`[avif] ${avifenc} could not report its version; the image library encodes AVIF and the tool is asked again in ${AVIFENC_PROBE_RETRY_MS / 1000} s`);
    return false;
  } finally {
    state.pending = undefined;
  }
}

async function reportsSupportedVersion(avifenc: string, probeTimeoutMs: number): Promise<boolean> {
  const stat = fs.statSync(avifenc);
  const key = `${avifenc}|${stat.size}|${stat.mtimeMs}`;
  let state = probes.get(key);
  if (state === undefined) {
    state = {};
    probes.set(key, state);
  }
  if (state.verdict !== undefined) return state.verdict;
  if (state.pending !== undefined) return state.pending;
  if (state.failedAt !== undefined && Date.now() - state.failedAt < AVIFENC_PROBE_RETRY_MS) return false;
  state.pending = probeVersion(avifenc, key, state, probeTimeoutMs);
  return state.pending;
}

/**
 * Where a usable encoder is installed, or null. The environment is read on every call; the tool is run only to ask
 * for its version, once. A value of `AVIFENC_PATH` is authoritative and must be the absolute path of an executable
 * regular file; one that is not means the image library encodes, and is logged once because the operator asked
 * for something else.
 */
export async function findAvifenc(env: NodeJS.ProcessEnv = process.env, probeTimeoutMs: number = AVIFENC_PROBE_TIMEOUT_MS): Promise<string | null> {
  const override = env[AVIFENC_PATH_ENV];
  if (override !== undefined && override !== '') {
    if (path.isAbsolute(override) && isExecutableFile(override)) return (await reportsSupportedVersion(override, probeTimeoutMs)) ? override : null;
    reportOnce(override, `${AVIFENC_PATH_ENV} is set but is not the absolute path of an executable file; the image library encodes AVIF`);
    return null;
  }
  for (const candidate of AVIFENC_CANDIDATES) {
    if (isExecutableFile(candidate) && (await reportsSupportedVersion(candidate, probeTimeoutMs))) return candidate;
  }
  return null;
}

/** Threads for one run: the cores this process may use, at most `AVIFENC_MAX_THREADS`; tiles bound what a small picture can use. */
function encoderThreads(): number {
  return Math.max(1, Math.min(os.availableParallelism(), AVIFENC_MAX_THREADS));
}

/**
 * Arguments of one encode. Quality applies to colour and alpha alike, as in the image library; a tuning metric
 * applies to the colour planes only (the alpha plane keeps the encoder's PSNR tuning). Reading the picture from a
 * path and writing to a path in the private directory keeps every file name fixed.
 */
export function avifencArguments(request: AvifCliRequest, inputPath: string, outputPath: string): string[] {
  if (!Number.isInteger(request.quality) || request.quality < AVIFENC_QUALITY_MIN || request.quality > AVIFENC_QUALITY_MAX) {
    throw new ConversionFailedError(`Cannot encode the image as .avif (the quality must be a whole number from ${AVIFENC_QUALITY_MIN} to ${AVIFENC_QUALITY_MAX})`);
  }
  const quality = String(request.quality);
  const args = [
    '-d',
    String(request.bitdepth),
    '-y',
    YUV_FORMAT[request.layout],
    '-q',
    quality,
    '--qalpha',
    quality,
    '-s',
    String(avifSpeedFor(request.effort)),
    '-j',
    String(encoderThreads()),
  ];
  if (request.tune !== undefined) args.push('-a', `c:tune=${request.tune}`);
  if (request.cicp) args.push('--cicp', `${request.cicp.primaries}/${request.cicp.transfer}/${request.cicp.matrix}`);
  args.push(inputPath, '-o', outputPath);
  return args;
}

function describeFailure(err: unknown, timeoutMs: number): Error {
  rethrowSandboxUnavailable(err);
  if (err instanceof SandboxedTimeoutError) {
    return new ConversionFailedError(`Cannot encode the image as .avif (the encoder did not finish within ${timeoutMs} ms)`);
  }
  if (err instanceof SandboxedMemoryLimitError || err instanceof SandboxedBufferLimitError) {
    return new PayloadLimitError('Cannot encode the image as .avif: it needs more memory or output than AVIF encoding allows');
  }
  if (err instanceof SandboxedProcessError) {
    if (err.exitCode === NOT_EXECUTABLE_STATUS || err.exitCode === NOT_FOUND_STATUS) {
      return new EngineUnavailableError('avifenc', 'the executable cannot be started');
    }
    console.warn(`[avif] avifenc failed with status ${String(err.exitCode)}: ${err.stderr.replace(/\s+/g, ' ').trim().slice(0, AVIFENC_DIAGNOSTIC_LOGGED_CHARS)}`);
    return new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder failed on the picture)');
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Removes the private directory; a failure to do so is logged and never replaces the result or the typed error of the run. */
async function removeJobDir(jobDir: string): Promise<void> {
  await fs.promises.rm(jobDir, { recursive: true, force: true, maxRetries: AVIFENC_CLEANUP_RETRIES, retryDelay: AVIFENC_CLEANUP_RETRY_DELAY_MS }).catch((err: unknown) => {
    console.warn(`[avif] could not remove the encoder working directory ${jobDir}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Reads the file the encoder wrote: a regular file (not a link) within `maxBytes`, opened without following a link. */
async function readEncoderOutput(outputPath: string, maxBytes: number): Promise<Buffer> {
  const missing = new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder produced no output)');
  let handle: fs.promises.FileHandle | undefined;
  try {
    const linkStat = await fs.promises.lstat(outputPath).catch(() => null);
    if (linkStat === null) throw missing;
    if (!linkStat.isFile()) throw new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder produced no regular file)');
    if (linkStat.size > maxBytes) throw new PayloadLimitError('Cannot encode the image as .avif: it needs more memory or output than AVIF encoding allows');
    handle = await fs.promises.open(outputPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => undefined);
    if (handle === undefined) throw new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder output could not be read)');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) throw new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder output changed while it was read)');
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}

/** Encodes `request` with the executable at `avifenc` and returns the AVIF file. */
export async function encodeAvifWithCli(avifenc: string, request: AvifCliRequest, limits: AvifCliLimits = {}): Promise<Buffer> {
  const timeoutMs = limits.timeoutMs ?? AVIFENC_TIMEOUT_MS;
  const maxOutputBytes = request.width * request.height * AVIFENC_MAX_OUTPUT_BYTES_PER_PIXEL + AVIFENC_OUTPUT_OVERHEAD_BYTES;
  let jobDir: string;
  try {
    jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), AVIFENC_JOB_DIR_PREFIX));
  } catch {
    throw new ConversionFailedError('Cannot encode the image as .avif (the encoder working directory could not be created)');
  }
  const inputPath = path.join(jobDir, AVIFENC_INPUT_NAME);
  const outputPath = path.join(jobDir, AVIFENC_OUTPUT_NAME);
  try {
    const args = avifencArguments(request, inputPath, outputPath);
    try {
      await fs.promises.writeFile(inputPath, request.png, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    } catch {
      throw new ConversionFailedError('Cannot encode the image as .avif (the picture could not be handed to the encoder)');
    }
    try {
      await executeSandboxedBinary(avifenc, args, {
        cwd: jobDir,
        timeoutMs,
        maxBuffer: AVIFENC_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: maxOutputBytes,
        memoryLimitMb: AVIFENC_MEMORY_LIMIT_MB,
        rlimits: { asBytes: AVIFENC_ADDRESS_SPACE_MB * BYTES_PER_MB },
        networkIsolated: true,
        signal: request.signal,
      });
    } catch (err) {
      throw describeFailure(err, timeoutMs);
    }
    const encoded = await readEncoderOutput(outputPath, maxOutputBytes);
    if (!isAvif(encoded)) {
      throw new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder produced no AVIF file)');
    }
    return encoded;
  } finally {
    await removeJobDir(jobDir);
  }
}
