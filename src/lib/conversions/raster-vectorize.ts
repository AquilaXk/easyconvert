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
import { isSvg, sanitizeSvgDocument } from '../security/svg-sanitizer';
import { decodeBmp } from './bmp';
import { pipelineFromBitmap } from './bitmap-pipeline';
import {
  asInputPixelLimitError,
  assertEncodedImageWithinLimit,
  InputPixelLimitError,
  openLimitedSharp,
  type PixelBudget,
} from './image-input-limits';
import { stageTimeoutMs } from './job-time';
import { resolveBinaryPath } from './pdf-postprocess/utils';
import { vectorizeOptionsProblem, type VectorizeOptions } from './raster-vectorize-options';

/**
 * Raster pictures traced to SVG by vtracer (visioncortex, MIT OR Apache-2.0), the engine the reference converter runs for the
 * same pairs, as an unmodified release program pinned by SHA-256 in scripts/install-vtracer.sh. The picture is decoded here first,
 * under the input pixel limit and the budget below, and handed to the program as an 8-bit RGBA PNG of its first frame, so the
 * program only ever reads a PNG this process wrote. It runs in the process sandbox without a network, with a time, memory,
 * file-size and diagnostics limit, and its SVG passes through the sanitizer of every SVG path before it is returned.
 */

const ENGINE_NAME = 'vtracer';
const ENGINE_PATH_VARIABLE = 'VTRACER_PATH';
const ENGINE_CANDIDATES = ['/usr/local/bin/vtracer', '/usr/bin/vtracer', '/opt/homebrew/bin/vtracer'];

/**
 * The engine has no limit of its own. Measured with the pinned build on linux/arm64 (docs/policy-decisions.md, raster to SVG):
 * a photograph of 16 megapixels takes 18 s and 660 MB with the poster preset and writes 10.4 MB, while random noise, the input
 * that gives every pixel a path, takes 200 s and 2.7 GB at 16 megapixels with the defaults. 16 megapixels keeps every real
 * picture of the measured set inside the limits below; the memory, time and output limits stop the adversarial ones.
 */
const VECTORIZE_PIXEL_BUDGET: PixelBudget = { maxPixels: 16_000_000, scope: 'tracing a picture to SVG' };
const ENGINE_DEFAULT_TIMEOUT_MS = 120_000;
const ENGINE_MEMORY_LIMIT_MB = 2048;
/** The largest SVG written: three times the measured 16 MP poster trace, and what the sanitizer is allowed to read for this path. */
export const VECTORIZE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** The program prints one line, or a panic message; anything longer is not a diagnostic. */
const ENGINE_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_DETAIL_CHARS = 160;
const INPUT_NAME = 'input.png';
const OUTPUT_NAME = 'output.svg';
const SHELL_NOT_EXECUTABLE = 126;
const SHELL_NOT_FOUND = 127;
const SIGSEGV = 'SIGSEGV';
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

/** The CLI flags of the options a request set, in the engine's spelling. Explicit flags override the preset, so only set values are sent. */
function vectorizeArgs(options: VectorizeOptions): string[] {
  const args: string[] = [];
  if (options.preset !== undefined) args.push('--preset', options.preset);
  if (options.mode !== undefined) args.push('--mode', options.mode);
  if (options.filterSpeckle !== undefined) args.push('--filter-speckle', String(options.filterSpeckle));
  if (options.colorPrecision !== undefined) args.push('--color-precision', String(options.colorPrecision));
  if (options.simplify !== undefined) args.push('--simplify', String(options.simplify));
  return args;
}

function parseOptions(raw: unknown): VectorizeOptions {
  if (raw === undefined) return {};
  const problem = vectorizeOptionsProblem(raw);
  if (problem !== null) throw new UnsupportedOptionError(problem);
  return raw as VectorizeOptions;
}

function engineBinary(): string {
  const binary = resolveBinaryPath(ENGINE_PATH_VARIABLE, ENGINE_CANDIDATES, ENGINE_NAME);
  if (binary === null) throw new EngineUnavailableError(ENGINE_NAME, 'vtracer is not installed or not in PATH');
  return binary;
}

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

/** The first frame or page, upright, as an 8-bit sRGB PNG with alpha: what the program reads. */
async function stagePicture(input: Buffer, sourceFormat: string): Promise<Buffer> {
  const picture = await openPicture(input, sourceFormat);
  try {
    return await picture
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .png(STAGED_PNG)
      .toBuffer();
  } catch (error) {
    const mapped = asInputPixelLimitError(error);
    if (mapped instanceof InputPixelLimitError) throw mapped;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConversionFailedError(`Invalid image: the picture could not be decoded (${reason}).`);
  }
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
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError('SVG tracing', timeoutMs);
  // The sandbox reports SIGSEGV under a memory limit as a memory refusal, but a fault in the program is not one: Rust ends a failed
  // allocation with the abort that ALLOCATION_FAILURE matches.
  if (error instanceof SandboxedMemoryLimitError) return error.signal === SIGSEGV ? traceFailure(`was stopped by ${SIGSEGV}`) : memoryRefusal();
  if (error instanceof SandboxedBufferLimitError) {
    return error.limitBytes === VECTORIZE_MAX_OUTPUT_BYTES ? outputRefusal() : new ConversionFailedError('The SVG tracer printed more diagnostics than the limit allows.');
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

async function trace(picture: Buffer, args: string[], options: ConversionOptions): Promise<string> {
  const binary = engineBinary();
  const timeoutMs = stageTimeoutMs(options, ENGINE_DEFAULT_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, INPUT_NAME);
    const outputPath = path.join(sandboxDir, OUTPUT_NAME);
    fs.writeFileSync(inputPath, picture, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, [...args, '--input', inputPath, '--output', outputPath], {
        cwd: sandboxDir,
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

/**
 * Traces a PNG, JPEG, WebP, GIF, BMP or TIFF picture to SVG. Refuses a picture over the pixel budget (413) before it is decoded,
 * bytes that do not decode (400), invalid options (400), a trace past the memory or output limit (413) or the time limit (422),
 * and answers engine-unavailable (503, retried on another worker) when the program is missing. Never returns a partial SVG.
 */
export async function vectorizeRaster(input: Buffer, sourceFormat: string, options: ConversionOptions, originalFilename: string): Promise<ConversionResult> {
  const baseName = (originalFilename || 'image').replace(/\.[^/.]+$/, '');
  const args = vectorizeArgs(parseOptions(options.vectorize));
  const picture = await stagePicture(input, sourceFormat);
  const svg = sanitizeSvgDocument(await trace(picture, args, options), VECTORIZE_MAX_OUTPUT_BYTES);
  if (!isSvg(svg)) throw new ConversionFailedError('The SVG tracer wrote something that is not an SVG document.');
  const buffer = Buffer.from(svg, 'utf8');
  return { buffer, mimeType: SVG_MIME_TYPE, filename: `${baseName}.svg`, size: buffer.length };
}
