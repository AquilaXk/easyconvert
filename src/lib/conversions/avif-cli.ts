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
 * management) and hands them over as a PNG on standard input: PNG keeps 8 or 16 bits per sample, one to four
 * channels and the EXIF block, and costs about 4 ms at compression level 1 where the encoder takes 25 to 100 ms.
 * The encoder writes into a private directory that is removed afterwards.
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
const AVIFENC_OUTPUT_NAME = 'out.avif';
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

/** Values of `AVIFENC_PATH` already reported as unusable, so each is reported once. */
const reportedUnusableOverrides = new Set<string>();

/**
 * Where the encoder is installed, or null. The environment is read on every call and nothing is run. A value of
 * `AVIFENC_PATH` is authoritative and must be the absolute path of an executable regular file; one that is not
 * means the image library encodes, and is logged once because the operator asked for something else.
 */
export function findAvifenc(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[AVIFENC_PATH_ENV];
  if (override !== undefined && override !== '') {
    if (path.isAbsolute(override) && isExecutableFile(override)) return override;
    if (!reportedUnusableOverrides.has(override)) {
      reportedUnusableOverrides.add(override);
      console.warn(`[avif] ${AVIFENC_PATH_ENV} is set but is not the absolute path of an executable file; the image library encodes AVIF`);
    }
    return null;
  }
  return AVIFENC_CANDIDATES.find((candidate) => isExecutableFile(candidate)) ?? null;
}

/** Threads for one run: the cores this process may use, at most `AVIFENC_MAX_THREADS`; tiles bound what a small picture can use. */
function encoderThreads(): number {
  return Math.max(1, Math.min(os.availableParallelism(), AVIFENC_MAX_THREADS));
}

/**
 * Arguments of one encode. Quality applies to colour and alpha alike, as in the image library; a tuning metric
 * applies to the colour planes only (the alpha plane keeps the encoder's PSNR tuning). Reading the picture from
 * standard input and writing to a path in the private directory keeps every file name fixed.
 */
export function avifencArguments(request: AvifCliRequest, outputPath: string): string[] {
  if (!Number.isInteger(request.quality) || request.quality < AVIFENC_QUALITY_MIN || request.quality > AVIFENC_QUALITY_MAX) {
    throw new ConversionFailedError(`Cannot encode the image as .avif (the quality must be a whole number from ${AVIFENC_QUALITY_MIN} to ${AVIFENC_QUALITY_MAX})`);
  }
  const quality = String(request.quality);
  const args = [
    '--stdin',
    '--input-format',
    'png',
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
  args.push('-o', outputPath);
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
  const outputPath = path.join(jobDir, AVIFENC_OUTPUT_NAME);
  try {
    try {
      await executeSandboxedBinary(avifenc, avifencArguments(request, outputPath), {
        cwd: jobDir,
        stdin: request.png,
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
