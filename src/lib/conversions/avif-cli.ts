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
import type { PixelBudget } from './image-input-limits';

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

/** Environment variable that names the executable; a value is authoritative, so a path with no file behind it means "not installed". */
export const AVIFENC_PATH_ENV = 'AVIFENC_PATH';
const AVIFENC_CANDIDATES = ['/usr/bin/avifenc', '/usr/local/bin/avifenc', '/opt/homebrew/bin/avifenc'];

/**
 * Resident memory of one run, measured: 37 bytes per pixel for 8-bit RGB at speeds 2, 3 and 6 (591 MB at 16
 * megapixels, 1.32 GB at 36) and 45 bytes per pixel for 16-bit RGB written as 10-bit 4:4:4 (2.87 GB at 64
 * megapixels). 48 megapixels (an 8000 x 6000 frame) keeps one run near 2.2 GB of the 3.3 GB that docker-compose.yml
 * gives each of 3 concurrent jobs, with the raster and the PNG this process holds on top.
 */
export const AVIFENC_PIXEL_BUDGET: PixelBudget = { maxPixels: 48_000_000, scope: 'AVIF encoding' };
/** Resident memory the sandbox allows one run before it kills the process group. */
export const AVIFENC_MEMORY_LIMIT_MB = 3072;
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
/** Exit statuses of a process that could not be started (not executable, not found). */
const NOT_EXECUTABLE_STATUS = 126;
const NOT_FOUND_STATUS = 127;

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
}

/** Where the encoder is installed, or null. The environment is read on every call and nothing is run. */
export function findAvifenc(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[AVIFENC_PATH_ENV];
  if (override !== undefined && override !== '') return path.isAbsolute(override) && fs.existsSync(override) ? override : null;
  return AVIFENC_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Threads for one run: the cores this process may use, as the encoder's own `all` would take; tiles bound what a small picture can use. */
function encoderThreads(): number {
  return Math.max(1, os.availableParallelism());
}

/**
 * Arguments of one encode. Quality applies to colour and alpha alike, as in the image library; a tuning metric
 * applies to the colour planes only (the alpha plane keeps the encoder's PSNR tuning). Reading the picture from
 * standard input and writing to a path in the private directory keeps every file name fixed.
 */
export function avifencArguments(request: AvifCliRequest, outputPath: string): string[] {
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

function describeFailure(err: unknown): Error {
  rethrowSandboxUnavailable(err);
  if (err instanceof SandboxedTimeoutError) {
    return new ConversionFailedError(`Cannot encode the image as .avif (the encoder did not finish within ${AVIFENC_TIMEOUT_MS} ms)`);
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

/** Encodes `request` with the executable at `avifenc` and returns the AVIF file. */
export async function encodeAvifWithCli(avifenc: string, request: AvifCliRequest): Promise<Buffer> {
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), AVIFENC_JOB_DIR_PREFIX));
  const outputPath = path.join(jobDir, AVIFENC_OUTPUT_NAME);
  try {
    try {
      await executeSandboxedBinary(avifenc, avifencArguments(request, outputPath), {
        cwd: jobDir,
        stdin: request.png,
        timeoutMs: AVIFENC_TIMEOUT_MS,
        maxBuffer: AVIFENC_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: request.width * request.height * AVIFENC_MAX_OUTPUT_BYTES_PER_PIXEL + AVIFENC_OUTPUT_OVERHEAD_BYTES,
        memoryLimitMb: AVIFENC_MEMORY_LIMIT_MB,
        networkIsolated: true,
      });
    } catch (err) {
      throw describeFailure(err);
    }
    let encoded: Buffer;
    try {
      encoded = await fs.promises.readFile(outputPath);
    } catch {
      throw new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder produced no output)');
    }
    if (!isAvif(encoded)) {
      throw new ConversionFailedError('Cannot encode the image as .avif (the AVIF encoder produced no AVIF file)');
    }
    return encoded;
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true });
  }
}
