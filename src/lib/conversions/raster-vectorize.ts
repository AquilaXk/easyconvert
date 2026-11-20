import fs from 'node:fs';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
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
import { decodeIco } from './ico';
import { icnsPictureBytes } from './icns-picture';
import { pipelineFromBitmap } from './bitmap-pipeline';
import { decodeExternalImage } from './image-external-source';
import { withSortedTiffTags } from './image-tiff-directories';
import {
  asInputPixelLimitError,
  assertEncodedImageWithinLimit,
  assertPixelBudget,
  InputPixelLimitError,
  openLimitedSharp,
  type PixelBudget,
} from './image-input-limits';
import { readSandboxOutputIfPresent } from '../security/sandbox-output';
import { remainingJobMs, stageTimeoutMs } from './job-time';
import { resolveBinaryPath } from './pdf-postprocess/utils';
import { cleanAlphaEdgesInPlace } from './raster-vectorize-alpha';
import {
  DEFAULT_PATH_PRECISION,
  DEFAULT_VECTORIZE_OPTIMIZE,
  vectorizeArgs,
  vectorizeOptionsProblem,
  type VectorizeOptions,
} from './raster-vectorize-options';
import { compactTracedSvg } from './raster-vectorize-svg';

/**
 * Raster pictures traced to SVG by vtracer (visioncortex, MIT OR Apache-2.0). The picture is decoded here first, under the
 * input pixel limit and the 16-megapixel budget below, so the tracer never parses uploaded bytes. Its first frame or primary
 * icon entry is normalised to upright 8-bit sRGB RGBA, alpha-edge decontaminated (`raster-vectorize-alpha.ts`), and handed
 * either to `vtracer-pixels` (`scripts/vtracer-pixels`) as raw `(width, height) + RGBA` via scatter-gather `writev`, or to the
 * pinned `vtracer` release fallback as an uncompressed PNG. Output SVG receives responsive `viewBox` and single-pass SVGO
 * colour/path compaction (`raster-vectorize-svg.ts`) before passing through `sanitizeGeneratedSvg`.
 */

const ENGINE_NAME = 'vtracer';
const ENGINE_PATH_VARIABLE = 'VTRACER_PATH';
const ENGINE_CANDIDATES = ['/usr/local/bin/vtracer', '/usr/bin/vtracer', '/opt/homebrew/bin/vtracer'];
const PIXELS_ENGINE_NAME = 'vtracer-pixels';
const PIXELS_ENGINE_PATH_VARIABLE = 'VTRACER_PIXELS_PATH';
const PIXELS_ENGINE_CANDIDATES = ['/usr/local/bin/vtracer-pixels', '/usr/bin/vtracer-pixels', '/opt/homebrew/bin/vtracer-pixels'];

/**
 * Measured with the pinned build on linux/arm64 (docs/policy-decisions.md, entry 142): a 16 MP photograph takes 18 s and
 * 660 MB with the poster preset and writes 10.4 MB, while random noise takes 200 s and 2.7 GB at 16 MP. 16 megapixels keeps
 * real pictures inside the sandbox limits while the memory, time and output bounds stop adversarial inputs.
 */
const VECTORIZE_PIXEL_BUDGET: PixelBudget = { maxPixels: 16_000_000, scope: 'tracing a picture to SVG' };
const ENGINE_DEFAULT_TIMEOUT_MS = 120_000;
const ENGINE_MEMORY_LIMIT_MB = 2048;
export const VECTORIZE_MAX_OUTPUT_BYTES = MAX_GENERATED_SVG_CHARS;
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
const ALLOCATION_FAILURE = /memory allocation of \d+ bytes failed/;
const UNPRINTABLE = /[^\x20-\x7e]/g;
const STAGED_PNG = { compressionLevel: 0, adaptiveFiltering: false } as const;
const SVG_MIME_TYPE = 'image/svg+xml';

const BMP_SOURCE = 'bmp';
const ICON_DIRECTORY_SOURCES: ReadonlySet<string> = new Set(['ico', 'cur']);
const ICNS_SOURCE = 'icns';
const TIFF_SOURCES: ReadonlySet<string> = new Set(['tif', 'tiff']);
const PSD_SOURCES: ReadonlySet<string> = new Set(['psd', 'psb']);
const PSD_SIGNATURE = '8BPS';
const PSD_HEADER_MIN_BYTES = 22;

function parseOptions(raw: unknown): VectorizeOptions {
  if (raw === undefined) return {};
  const problem = vectorizeOptionsProblem(raw);
  if (problem !== null) throw new UnsupportedOptionError(problem);
  return raw as VectorizeOptions;
}

interface Engine {
  binary: string;
  readsPixels: boolean;
}

function selectEngine(): Engine {
  const pixels = resolveBinaryPath(PIXELS_ENGINE_PATH_VARIABLE, PIXELS_ENGINE_CANDIDATES, PIXELS_ENGINE_NAME);
  if (pixels !== null) return { binary: pixels, readsPixels: true };
  const binary = resolveBinaryPath(ENGINE_PATH_VARIABLE, ENGINE_CANDIDATES, ENGINE_NAME);
  if (binary === null) throw new EngineUnavailableError(ENGINE_NAME, 'vtracer is not installed or not in PATH');
  return { binary, readsPixels: false };
}

type StagedPicture = { png: Buffer } | { header: Buffer; pixels: Buffer };

/** Checks PSD canvas dimensions from the 26-byte file header (`8BPS`) before spawning ImageMagick. */
function assertPsdHeaderWithinBudget(input: Buffer): void {
  if (input.length >= PSD_HEADER_MIN_BYTES && input.toString('ascii', 0, 4) === PSD_SIGNATURE) {
    const height = input.readUInt32BE(14);
    const width = input.readUInt32BE(18);
    if (width > 0 && height > 0) {
      assertPixelBudget(width, height, VECTORIZE_PIXEL_BUDGET);
    }
  }
}

async function openPicture(input: Buffer, sourceFormat: string, signal?: AbortSignal): Promise<Sharp> {
  if (sourceFormat === BMP_SOURCE) {
    return pipelineFromBitmap(decodeBmp(input, VECTORIZE_PIXEL_BUDGET));
  }
  if (ICON_DIRECTORY_SOURCES.has(sourceFormat)) {
    const icon = decodeIco(input, undefined, VECTORIZE_PIXEL_BUDGET);
    if (icon.kind === 'png') {
      await assertEncodedImageWithinLimit(icon.png, VECTORIZE_PIXEL_BUDGET);
      return openLimitedSharp(icon.png);
    }
    return pipelineFromBitmap(icon.bitmap);
  }
  if (sourceFormat === ICNS_SOURCE) {
    const payload = await icnsPictureBytes(input, signal);
    await assertEncodedImageWithinLimit(payload, VECTORIZE_PIXEL_BUDGET);
    return openLimitedSharp(payload);
  }
  if (PSD_SOURCES.has(sourceFormat)) {
    assertPsdHeaderWithinBudget(input);
  }
  const readable = TIFF_SOURCES.has(sourceFormat) ? withSortedTiffTags(input) : input;
  const external = await decodeExternalImage(readable, sourceFormat, signal);
  const encoded = external !== null ? external.buffer : readable;
  await assertEncodedImageWithinLimit(encoded, VECTORIZE_PIXEL_BUDGET);
  return openLimitedSharp(encoded);
}

/** The first frame or primary icon entry, upright, as 8-bit sRGB RGBA with cleaned alpha edges. */
async function stagePicture(input: Buffer, sourceFormat: string, readsPixels: boolean, signal?: AbortSignal): Promise<StagedPicture> {
  const picture = await openPicture(input, sourceFormat, signal);
  try {
    const upright = picture.rotate().toColourspace('srgb').ensureAlpha();
    const { data, info } = await upright.raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== RGBA_CHANNELS || data.length !== info.width * info.height * RGBA_CHANNELS) {
      throw new ConversionFailedError('Invalid image: the picture could not be decoded to 8-bit RGBA.');
    }
    cleanAlphaEdgesInPlace(data, info.width, info.height);
    if (!readsPixels) {
      const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: RGBA_CHANNELS } })
        .png(STAGED_PNG)
        .toBuffer();
      return { png };
    }
    const header = Buffer.allocUnsafe(PIXELS_HEADER_BYTES);
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

/** Writes the staged picture to the sandbox scratch file; raw header + pixels use a single scatter-gather `writev`. */
function writeStaged(staged: StagedPicture, sandboxDir: string): string {
  if ('png' in staged) {
    const inputPath = path.join(sandboxDir, INPUT_NAME);
    fs.writeFileSync(inputPath, staged.png, { mode: 0o600 });
    return inputPath;
  }
  const inputPath = path.join(sandboxDir, PIXELS_INPUT_NAME);
  const file = fs.openSync(inputPath, 'w', 0o600);
  try {
    fs.writevSync(file, [staged.header, staged.pixels]);
  } finally {
    fs.closeSync(file);
  }
  return inputPath;
}

function memoryRefusal(): PayloadLimitError {
  return new PayloadLimitError(
    `Tracing this picture needs more than the ${ENGINE_MEMORY_LIMIT_MB} MB the SVG tracer may use. Simplify the picture, or raise filterSpeckle or lower colorPrecision.`
  );
}

function outputRefusal(): PayloadLimitError {
  return new PayloadLimitError(
    `The SVG traced from this picture is larger than ${VECTORIZE_MAX_OUTPUT_BYTES} bytes. Raise filterSpeckle or lower colorPrecision for fewer shapes.`
  );
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
    const svg = readSandboxOutputIfPresent(outputPath, (size) => {
      if (size >= VECTORIZE_MAX_OUTPUT_BYTES) throw outputRefusal();
    });
    if (svg === null) throw new ConversionFailedError('The SVG tracer wrote no SVG from this picture.');
    return svg.toString('utf8');
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

function assertTimeLeft(options: ConversionOptions): void {
  options.signal?.throwIfAborted();
  const remaining = remainingJobMs(options);
  if (remaining !== undefined && remaining <= 0) {
    throw new CpuTaskTimeoutError(TRACE_TASK, stageTimeoutMs(options, ENGINE_DEFAULT_TIMEOUT_MS), OUT_OF_TIME);
  }
}

export async function vectorizeRaster(input: Buffer, sourceFormat: string, options: ConversionOptions, originalFilename: string): Promise<ConversionResult> {
  const baseName = (originalFilename || 'image').replace(/\.[^/.]+$/, '');
  const parsed = parseOptions(options.vectorize);
  const args = vectorizeArgs(parsed);
  const engine = selectEngine();
  assertTimeLeft(options);
  const picture = await stagePicture(input, sourceFormat.toLowerCase(), engine.readsPixels, options.signal);
  assertTimeLeft(options);
  const rawSvg = await trace(engine.binary, picture, args, options);
  const compacted = compactTracedSvg(
    rawSvg,
    parsed.optimize ?? DEFAULT_VECTORIZE_OPTIMIZE,
    parsed.pathPrecision ?? DEFAULT_PATH_PRECISION
  );
  const svg = sanitizeGeneratedSvg(compacted);
  if (!isSvg(svg)) throw new ConversionFailedError('The SVG tracer wrote something that is not an SVG document.');
  const buffer = Buffer.from(svg, 'utf8');
  return { buffer, mimeType: SVG_MIME_TYPE, filename: `${baseName}.svg`, size: buffer.length };
}
