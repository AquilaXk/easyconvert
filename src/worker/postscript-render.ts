import fs from 'node:fs';
import path from 'node:path';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { ConversionFailedError } from '../lib/types';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { compressPpmPage, exceedsPpmPageLimit, PPM_PAGE_MAX_BYTES, ppmPageEnd, resolvePdfRasterDpi, selectsPages } from './poppler-ppm';
import { createConversionResult, handOffOutput, readDrawnPdfForImages, resolveInputContext, withSandboxDir, writeOutputSegments } from './worker-output';
import { ghostscriptPdfArguments, ghostscriptRasterArguments, siblingGhostscript, skipsGarbageCollection } from './postscript-gs';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
} from './sandbox';

/**
 * PostScript sources (EPS, PS) are drawn by the interpreter: an EPS that becomes a PNG in one run straight to pixels, every
 * other target through a PDF that the native PDF tools take from there (see postscript-gs.ts for why `gs` runs beside
 * `ps2pdf` instead of the scripts).
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MEMORY_LIMIT_MB = 2048;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
/** The interpreter runs in its safe mode: the file cannot read or write other files or start programs. */
const INTERPRETER_FLAGS: readonly string[] = ['-dSAFER'];
/** An EPS is a figure, not a page: the PDF page is cropped to its %%BoundingBox instead of the default paper size. */
const EPS_SOURCE = 'eps';
const EPS_CROP_FLAG = '-dEPSCrop';
const PNG_TARGET = 'png';
const PDF_TARGET = 'pdf';
const TEMP_PREFIX = 'easyconvert-postscript-';
const PPM_PAGE_FILE = 'page.ppm';
/** The interpreter writes its result to a file in the job directory and prints nothing the worker has to copy, so the launcher has no output to move. */
const NO_PIPED_OUTPUT_BYTES = 0;

export interface PostScriptJob {
  input: Buffer | WorkerVfsPayload;
  /** `eps` or `ps`. */
  src: string;
  tgt: string;
  options: WorkerEngineOptions;
  originalFilename: string;
  /** The configured `ps2pdf`. */
  interpreter: string;
  /** Hands a PDF to the native PDF tools (Poppler images and SVG, the encoded rasters, pdftops, the DXF writer). */
  convertPdfPages: (pdf: Buffer, tgt: string, options: WorkerEngineOptions, originalFilename: string) => Promise<WorkerConversionResult | null>;
}

/** What one run of the interpreter needs besides its arguments. */
interface Run {
  tempDir: string;
  limits: LaunchedExecutionOptions;
  smallInput: boolean;
}

/** True when the interpreter was stopped for the memory it asked for, not for what is in the file. */
function isMemoryExhaustion(err: unknown): boolean {
  if (err instanceof SandboxedMemoryLimitError) return true;
  return err instanceof SandboxedProcessError && /VMerror|memory/i.test(err.stderr);
}

/** The typed error for a run that failed: its limits, or what the interpreter printed about the file. */
function toInterpreterError(err: unknown, src: string, tempDir: string): unknown {
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`The PostScript interpreter exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) {
    const detail = err.stderr.trim().slice(0, MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>');
    return new ConversionFailedError(`The PostScript interpreter rejected the .${src} file${detail ? `: ${detail}` : ''}`);
  }
  return err;
}

/**
 * Runs an attempt without garbage collection when the input is small (see postscript-gs.ts). A program that exhausts
 * memory that way is run again with the collector on, which is how the interpreter runs everything else.
 */
async function withGarbageCollectionFallback<T>(skipGarbageCollection: boolean, attempt: (noGarbageCollection: boolean) => Promise<T>): Promise<T> {
  if (!skipGarbageCollection) return attempt(false);
  try {
    return await attempt(true);
  } catch (err) {
    if (!isMemoryExhaustion(err)) throw err;
    return attempt(false);
  }
}

/** Bytes of the input, from its length or its file, without reading it. */
function inputByteLength(input: Buffer | WorkerVfsPayload): number {
  if (Buffer.isBuffer(input)) return input.length;
  if (input.inputBuffer) return input.inputBuffer.length;
  return input.inputPath ? fs.statSync(input.inputPath).size : Number.POSITIVE_INFINITY;
}

/** Writes the PDF of a PostScript file: `gs` straight away when it is next to `ps2pdf`, else the configured `ps2pdf`. */
async function writePdf(job: PostScriptJob, ghostscript: string | null, run: Run, inputPath: string, pdfPath: string): Promise<void> {
  const isEps = job.src === EPS_SOURCE;
  try {
    if (ghostscript) {
      await withGarbageCollectionFallback(run.smallInput, (noGarbageCollection) =>
        launchSandboxedBinary(ghostscript, ghostscriptPdfArguments(isEps, inputPath, pdfPath, noGarbageCollection), {
          ...run.limits,
          cwd: run.tempDir,
          expectedOutputBytes: NO_PIPED_OUTPUT_BYTES,
        })
      );
    } else {
      const flags = isEps ? [...INTERPRETER_FLAGS, EPS_CROP_FLAG] : INTERPRETER_FLAGS;
      await executeSandboxedBinary(job.interpreter, [...flags, inputPath, pdfPath], { ...run.limits, cwd: run.tempDir });
    }
  } catch (err) {
    throw toInterpreterError(err, job.src, run.tempDir);
  }
  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
    throw new ConversionFailedError(`The PostScript interpreter drew no page from the .${job.src} file.`);
  }
}

/**
 * Draws an EPS figure as one PNG with a single interpreter run: the PPM page is written to the job directory and the
 * in-process PNG encoder compresses it (poppler-ppm.ts). Returns null when this route cannot give the answer the PDF
 * route would: the figure shows several pages, or its page is above the raw-size limit; the caller then takes the PDF route.
 */
async function renderEpsToPng(job: PostScriptJob, ghostscript: string, limits: LaunchedExecutionOptions, smallInput: boolean): Promise<WorkerConversionResult | null> {
  const { input, options } = job;
  const dpi = resolvePdfRasterDpi(options);
  const startTime = Date.now();
  const rendered = await withSandboxDir(TEMP_PREFIX, async (tempDir) => {
    const { inputPath } = resolveInputContext(input, EPS_SOURCE, tempDir);
    const pagePath = path.join(tempDir, PPM_PAGE_FILE);
    try {
      await withGarbageCollectionFallback(smallInput, (noGarbageCollection) =>
        launchSandboxedBinary(ghostscript, ghostscriptRasterArguments(true, dpi, inputPath, pagePath, noGarbageCollection), {
          ...limits,
          cwd: tempDir,
          maxFileSize: PPM_PAGE_MAX_BYTES,
          expectedOutputBytes: NO_PIPED_OUTPUT_BYTES,
        })
      );
    } catch (err) {
      // A page above the raw-size limit is the PDF route's to draw.
      if (err instanceof SandboxedBufferLimitError) return null;
      throw toInterpreterError(err, EPS_SOURCE, tempDir);
    }
    // A host without file-size limits lets the page grow past it: the size is checked before the page is read.
    if (!fs.existsSync(pagePath) || exceedsPpmPageLimit(fs.statSync(pagePath).size)) return null;
    return fs.readFileSync(pagePath);
  });
  if (rendered === null || rendered.length === 0 || ppmPageEnd(rendered) !== rendered.length) return null;
  const png = await compressPpmPage(rendered, dpi);
  const persistedPath = writeOutputSegments([png], PNG_TARGET, options, Buffer.isBuffer(input) ? undefined : input);
  return createConversionResult(persistedPath, PNG_TARGET, baseNameOf(job), 'native-postscript', Date.now() - startTime);
}

function baseNameOf(job: PostScriptJob): string {
  return job.originalFilename ? job.originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
}

/**
 * Renders PostScript (EPS, PS) and, for targets other than PDF and PNG, hands the PDF to the native tools every PDF
 * source uses (Poppler images and SVG, the encoded rasters, pdftops and the DXF writer).
 */
export async function convertPostScript(job: PostScriptJob): Promise<WorkerConversionResult | null> {
  const { input, src, tgt, options, originalFilename } = job;
  const startTime = Date.now();
  const timeoutMs = Math.min(stageTimeoutMs(options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const ghostscript = siblingGhostscript(job.interpreter);
  const limits: LaunchedExecutionOptions = {
    timeoutMs,
    maxBuffer: options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
    maxFileSize: MAX_OUTPUT_BYTES,
    memoryLimitMb: MEMORY_LIMIT_MB,
    networkIsolated: true,
    signal: options.signal,
  };
  const smallInput = skipsGarbageCollection(inputByteLength(input));

  // An EPS figure that becomes a PNG is drawn once by the interpreter, straight to pixels.
  if (tgt === PNG_TARGET && ghostscript && src === EPS_SOURCE && !selectsPages(options)) {
    const drawn = await renderEpsToPng(job, ghostscript, limits, smallInput);
    if (drawn) return drawn;
  }

  if (tgt === PDF_TARGET) {
    return withSandboxDir(TEMP_PREFIX, async (tempDir) => {
      const { inputPath } = resolveInputContext(input, src, tempDir);
      const pdfPath = path.join(tempDir, 'rendered.pdf');
      await writePdf(job, ghostscript, { tempDir, limits, smallInput }, inputPath, pdfPath);
      const persistedPath = handOffOutput(pdfPath, PDF_TARGET, options, Buffer.isBuffer(input) ? undefined : input);
      return createConversionResult(persistedPath, PDF_TARGET, baseNameOf(job), 'native-postscript', Date.now() - startTime);
    });
  }

  const pdf = await withSandboxDir(TEMP_PREFIX, async (tempDir) => {
    const { inputPath } = resolveInputContext(input, src, tempDir);
    const pdfPath = path.join(tempDir, 'rendered.pdf');
    await writePdf(job, ghostscript, { tempDir, limits, smallInput }, inputPath, pdfPath);
    return readDrawnPdfForImages(pdfPath, 'The PostScript interpreter', src);
  });
  return job.convertPdfPages(pdf, tgt, options, originalFilename);
}
