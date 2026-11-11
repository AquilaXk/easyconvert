import fs from 'node:fs';
import path from 'node:path';
import type { Sharp } from 'sharp';
import {
  ConversionFailedError,
  CpuTaskTimeoutError,
  EngineUnavailableError,
  PayloadLimitError,
  UnsupportedOptionError,
  type ConversionOptions,
  type ConversionResult,
} from '../types';
import {
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  cleanupWorkerSandboxDir,
  createWorkerSandboxDir,
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
} from '../../worker/sandbox';
import { isSvg, MAX_GENERATED_SVG_CHARS, sanitizeGeneratedSvg } from '../security/svg-sanitizer';
import { decodeBmp } from './bmp';
import { pipelineFromBitmap } from './bitmap-pipeline';
import {
  asInputPixelLimitError,
  assertEncodedImageWithinLimit,
  InputPixelLimitError,
  openLimitedSharp,
  type PixelBudget,
} from './image-input-limits';
import { remainingJobMs, stageTimeoutMs } from './job-time';
import { resolveBinaryPath } from './pdf-postprocess/utils';
import { vectorizeArgs, vectorizeOptionsProblem, type VectorizeOptions } from './raster-vectorize-options';

/**
 * Raster pictures traced to SVG by vtracer (visioncortex, MIT OR Apache-2.0), the engine the reference converter runs for the
 * same pairs. The picture is decoded here first, under the input pixel limit and the budget below, so the program never reads
 * uploaded bytes. It is handed the pixels of the first frame, 8-bit RGBA, in one of two ways, and writes the same SVG for both:
 * to the vtracer-pixels program (scripts/vtracer-pixels, built from the vtracer source by scripts/install-vtracer-pixels.sh) as
 * the raw pixels behind a width and a height, or, on a worker without it, to the release program pinned by SHA-256 in
 * scripts/install-vtracer.sh as a PNG this process wrote. It runs in the process sandbox without a network, with a time, memory,
 * file-size and diagnostics limit, and its SVG passes through the sanitizer of every SVG path before it is returned.
 */

const ENGINE_NAME = 'vtracer';
const ENGINE_PATH_VARIABLE = 'VTRACER_PATH';
const ENGINE_CANDIDATES = ['/usr/local/bin/vtracer', '/usr/bin/vtracer', '/opt/homebrew/bin/vtracer'];
const PIXELS_ENGINE_NAME = 'vtracer-pixels';
const PIXELS_ENGINE_PATH_VARIABLE = 'VTRACER_PIXELS_PATH';
const PIXELS_ENGINE_CANDIDATES = ['/usr/local/bin/vtracer-pixels', '/usr/bin/vtracer-pixels', '/opt/homebrew/bin/vtracer-pixels'];

/**
 * The engine has no limit of its own. Measured with the pinned build on linux/arm64 (docs/policy-decisions.md, raster to SVG):
 * a photograph of 16 megapixels takes 18 s and 660 MB with the poster preset and writes 10.4 MB, while random noise, the input
 * that gives every pixel a path, takes 200 s and 2.7 GB at 16 megapixels with the defaults. 16 megapixels keeps every real
 * picture of the measured set inside the limits below; the memory, time and output limits stop the adversarial ones.
 */
const VECTORIZE_PIXEL_BUDGET: PixelBudget = { maxPixels: 16_000_000, scope: 'tracing a picture to SVG' };
const ENGINE_DEFAULT_TIMEOUT_MS = 120_000;
const ENGINE_MEMORY_LIMIT_MB = 2048;
/** The largest SVG written: the bound the sanitizer reads generated SVG up to, three times the measured 16 MP poster trace. */
export const VECTORIZE_MAX_OUTPUT_BYTES = MAX_GENERATED_SVG_CHARS;
/** The program prints one line, or a panic message; anything longer is not a diagnostic. */
const ENGINE_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_DETAIL_CHARS = 160;
const INPUT_NAME = 'input.png';
const PIXELS_INPUT_NAME = 'input.rgba';
const RGBA_CHANNELS = 4;
const PIXELS_HEADER_BYTES = 8;
const OUTPUT_NAME = 'output.svg';
const SHELL_NOT_EXECUTABLE = 126;
const SHELL_NOT_FOUND = 127;
const SIGSEGV = 'SIGSEGV';
const TRACE_TASK = 'SVG tracing';
const OUT_OF_TIME = 'The conversion ran out of time before the SVG tracer could start.';
/** What Rust's default allocation-error handler prints before it aborts, which is how the address-space limit ends the program. */
const ALLOCATION_FAILURE = /memory allocation of \d+ bytes failed/;
const UNPRINTABLE = /[^\x20-\x7e]/g;
/**
 * The staged PNG is stored without deflate or row filters: the program reads it once from the scratch directory, and on the
 * linux/arm64 runs of the generated corpus the encode took 3.7 ms instead of 15.8 ms at level 1 for a 768 x 512 photograph,
 * with the same SVG.
 */
const STAGED_PNG = { compressionLevel: 0, adaptiveFiltering: false } as const;
const SVG_MIME_TYPE = 'image/svg+xml';

function parseOptions(raw: unknown): VectorizeOptions {
  if (raw === undefined) return {};
  const problem = vectorizeOptionsProblem(raw);
  if (problem !== null) throw new UnsupportedOptionError(problem);
  return raw as VectorizeOptions;
}

/** The program that traces, and what it reads: the raw pixels (vtracer-pixels) or a PNG (the release program). */
interface Engine {
  binary: string;
  readsPixels: boolean;
}

/** vtracer-pixels when the worker has it, otherwise the release program; neither is a 503 before any decoding. */
function selectEngine(): Engine {
  const pixels = resolveBinaryPath(PIXELS_ENGINE_PATH_VARIABLE, PIXELS_ENGINE_CANDIDATES, PIXELS_ENGINE_NAME);
  if (pixels !== null) return { binary: pixels, readsPixels: true };
  const binary = resolveBinaryPath(ENGINE_PATH_VARIABLE, ENGINE_CANDIDATES, ENGINE_NAME);
  if (binary === null) throw new EngineUnavailableError(ENGINE_NAME, 'vtracer is not installed or not in PATH');
  return { binary, readsPixels: false };
}

/** What a program is given: a PNG file, or the little-endian width and height (two u32) and then the width x height RGBA bytes. */
type StagedPicture = { png: Buffer } | { header: Buffer; pixels: Buffer };

const BMP_SOURCE = 'bmp';

/**
 * The picture as the image library reads it, after its size is checked against the budget. A BMP is read by the project's own
 * decoder (the image library has no BMP loader), which checks the budget from the header before it allocates the canvas, and is
 * handed on with its embedded profile as every other BMP conversion does.
 */
async function openPicture(input: Buffer, sourceFormat: string): Promise<Sharp> {
  if (sourceFormat !== BMP_SOURCE) {
    await assertEncodedImageWithinLimit(input, VECTORIZE_PIXEL_BUDGET);
    return openLimitedSharp(input);
  }
  return pipelineFromBitmap(decodeBmp(input, VECTORIZE_PIXEL_BUDGET));
}

/** The first frame or page, upright, as 8-bit sRGB with alpha: what the program reads. */
async function stagePicture(input: Buffer, sourceFormat: string, readsPixels: boolean): Promise<StagedPicture> {
  const picture = await openPicture(input, sourceFormat);
  try {
    const upright = picture.rotate().toColourspace('srgb').ensureAlpha();
    if (!readsPixels) return { png: await upright.png(STAGED_PNG).toBuffer() };
    const { data, info } = await upright.raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== RGBA_CHANNELS || data.length !== info.width * info.height * RGBA_CHANNELS) {
      throw new ConversionFailedError('Invalid image: the picture could not be decoded to 8-bit RGBA.');
    }
    const header = Buffer.alloc(PIXELS_HEADER_BYTES);
    header.writeUInt32LE(info.width, 0);
    header.writeUInt32LE(info.height, 4);
    return { header, pixels: data };
  } catch (error) {
    if (error instanceof ConversionFailedError) throw error;
    const mapped = asInputPixelLimitError(error);
    if (mapped instanceof InputPixelLimitError) throw mapped;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConversionFailedError(`Invalid image: the picture could not be decoded (${reason}).`);
  }
}

/** The staged picture in a file only this run can read; the header and the pixels are written one after the other, never joined. */
function writeStaged(staged: StagedPicture, sandboxDir: string): string {
  if ('png' in staged) {
    const inputPath = path.join(sandboxDir, INPUT_NAME);
    fs.writeFileSync(inputPath, staged.png, { mode: 0o600 });
    return inputPath;
  }
  const inputPath = path.join(sandboxDir, PIXELS_INPUT_NAME);
  const file = fs.openSync(inputPath, 'w', 0o600);
  try {
    fs.writeSync(file, staged.header);
    fs.writeSync(file, staged.pixels);
  } finally {
    fs.closeSync(file);
  }
  return inputPath;
}

function memoryRefusal(): PayloadLimitError {
  return new PayloadLimitError(`Tracing this picture needs more than the ${ENGINE_MEMORY_LIMIT_MB} MB the SVG tracer may use. Simplify the picture, or raise filterSpeckle or lower colorPrecision.`);
}

function outputRefusal(): PayloadLimitError {
  return new PayloadLimitError(`The SVG traced from this picture is larger than ${VECTORIZE_MAX_OUTPUT_BYTES} bytes. Raise filterSpeckle or lower colorPrecision for fewer shapes.`);
}

function firstLine(stderr: string, sandboxDir: string): string {
  const line = stderr.replaceAll(sandboxDir, '<tmp>').split('\n').map((text) => text.trim()).find(Boolean);
  return line === undefined ? '' : ` (${line.replace(UNPRINTABLE, '?').slice(0, MAX_DETAIL_CHARS)})`;
}

function traceFailure(how: string, detail = ''): ConversionFailedError {
  return new ConversionFailedError(`The SVG tracer could not trace this picture: it ${how}${detail}.`);
}

function toEngineError(error: unknown, sandboxDir: string, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError(TRACE_TASK, timeoutMs);
  // The sandbox counts SIGSEGV under a memory limit as a memory refusal, since a C program faults on an allocation it did not check.
  // A Rust program aborts instead: a failed allocation prints what ALLOCATION_FAILURE matches (std `default_alloc_error_hook`) and a
  // stack overflow prints its own message (std `stack_overflow.rs`), so a SIGSEGV of this program is most likely a fault in it, and is reported as one.
  if (error instanceof SandboxedMemoryLimitError) return error.signal === SIGSEGV ? traceFailure(`was stopped by ${SIGSEGV}`) : memoryRefusal();
  if (error instanceof SandboxedBufferLimitError) {
    return error.kind === 'file-size' ? outputRefusal() : new ConversionFailedError('The SVG tracer printed more diagnostics than the limit allows.');
  }
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) {
      return new EngineUnavailableError(ENGINE_NAME, 'vtracer could not be started');
    }
    if (ALLOCATION_FAILURE.test(error.stderr)) return memoryRefusal();
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with status ${error.exitCode}`;
    return traceFailure(how, firstLine(error.stderr, sandboxDir));
  }
  return error;
}

async function trace(binary: string, picture: StagedPicture, args: string[], options: ConversionOptions): Promise<string> {
  const timeoutMs = stageTimeoutMs(options, ENGINE_DEFAULT_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = writeStaged(picture, sandboxDir);
    const outputPath = path.join(sandboxDir, OUTPUT_NAME);
    try {
      await executeSandboxedBinary(binary, [...args, '--input', inputPath, '--output', outputPath], {
        cwd: sandboxDir,
        workDir: sandboxDir,
        timeoutMs,
        maxBuffer: ENGINE_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: VECTORIZE_MAX_OUTPUT_BYTES,
        memoryLimitMb: ENGINE_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (error) {
      throw toEngineError(error, sandboxDir, timeoutMs);
    }
    if (!fs.existsSync(outputPath)) throw new ConversionFailedError('The SVG tracer wrote no SVG from this picture.');
    // Where the file-size limit is not available (a host without prlimit), the size is checked after the run.
    if (fs.statSync(outputPath).size >= VECTORIZE_MAX_OUTPUT_BYTES) throw outputRefusal();
    return fs.readFileSync(outputPath, 'utf8');
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

/** Stops between stages when the conversion was cancelled, or its job deadline passed while the picture was decoded. */
function assertTimeLeft(options: ConversionOptions): void {
  options.signal?.throwIfAborted();
  const remaining = remainingJobMs(options);
  if (remaining !== undefined && remaining <= 0) throw new CpuTaskTimeoutError(TRACE_TASK, stageTimeoutMs(options, ENGINE_DEFAULT_TIMEOUT_MS), OUT_OF_TIME);
}

/**
 * Traces a PNG, JPEG, WebP, GIF, BMP or TIFF picture to SVG. Answers engine-unavailable (503, retried on another worker) when the
 * program is missing, before any decoding; refuses a picture over the pixel budget (413) before it is decoded, bytes that do not
 * decode (400), invalid options (400), a trace past the memory or output limit (413) or the time limit (422). Never returns a
 * partial SVG.
 */
export async function vectorizeRaster(input: Buffer, sourceFormat: string, options: ConversionOptions, originalFilename: string): Promise<ConversionResult> {
  const baseName = (originalFilename || 'image').replace(/\.[^/.]+$/, '');
  const args = vectorizeArgs(parseOptions(options.vectorize));
  const engine = selectEngine();
  assertTimeLeft(options);
  const picture = await stagePicture(input, sourceFormat, engine.readsPixels);
  assertTimeLeft(options);
  const svg = sanitizeGeneratedSvg(await trace(engine.binary, picture, args, options));
  if (!isSvg(svg)) throw new ConversionFailedError('The SVG tracer wrote something that is not an SVG document.');
  const buffer = Buffer.from(svg, 'utf8');
  return { buffer, mimeType: SVG_MIME_TYPE, filename: `${baseName}.svg`, size: buffer.length };
}
