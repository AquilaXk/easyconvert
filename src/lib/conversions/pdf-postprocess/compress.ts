import fs from 'node:fs';
import path from 'node:path';
import {
  EngineUnavailableError,
  PdfPostprocessError,
  UnsupportedOptionError,
  type PdfOptimizeOptions,
  type PdfOptimizeProfile,
} from '../../types';
import { SandboxedBufferLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../../security/process-sandbox';
import { executeSandboxedBinary } from '../../../worker/sandbox';
import { assertPdfHeader } from '../pdf-text-document';
import { openPdfForEditing, type PdfAccess } from '../pdf-access';
import { getGhostscriptBinaryPath } from './gs-path';
import { runQpdfToBuffer, withQpdfInputFile, withQpdfWorkspace } from './qpdf-run';

/**
 * PDF compression with named profiles. The result is never larger than the input: when a profile gains nothing the
 * input comes back unchanged with `optimized: false`, so a caller can tell "already compact" from "compressed".
 *
 *  - `web`, `print` and `max` rewrite the document with Ghostscript's pdfwrite: images above the profile's
 *    resolution are downsampled and recompressed as JPEG, duplicate images are stored once, fonts are subset and
 *    streams are deflated into object streams (PDF 1.6). The resolutions are the pdfwrite presets `/ebook` (150 dpi),
 *    `/printer` (300 dpi) and `/screen` (72 dpi).
 *  - `archive` is lossless and needs no Ghostscript: qpdf re-deflates every stream at the highest level and packs the
 *    objects into object streams. No pixel and no glyph changes.
 *
 * An encrypted input goes through the same gate as every other PDF edit (see pdf-access).
 */

export const PDF_OPTIMIZE_PROFILES: readonly PdfOptimizeProfile[] = ['web', 'print', 'archive', 'max'];
export const DEFAULT_PDF_OPTIMIZE_PROFILE: PdfOptimizeProfile = 'web';

/** pdfwrite settings of the profiles that rewrite images. */
const GHOSTSCRIPT_PRESETS: Readonly<Partial<Record<PdfOptimizeProfile, string>>> = {
  web: '/ebook',
  print: '/printer',
  max: '/screen',
};
/** PDF 1.6 lets pdfwrite pack objects into object streams, which a 1.4 file cannot. */
const GHOSTSCRIPT_COMPATIBILITY_LEVEL = '1.6';
const GHOSTSCRIPT_FIXED_ARGS: readonly string[] = [
  '-q',
  '-dNOPAUSE',
  '-dBATCH',
  '-dSAFER',
  // An error in the document is a failure of this operation, not a result with a page missing.
  '-dPDFSTOPONERROR',
  '-sDEVICE=pdfwrite',
  `-dCompatibilityLevel=${GHOSTSCRIPT_COMPATIBILITY_LEVEL}`,
];
const GHOSTSCRIPT_OUTPUT_NAME = 'output.pdf';
const GHOSTSCRIPT_DEFAULT_TIMEOUT_MS = 300_000;
const GHOSTSCRIPT_MEMORY_LIMIT_MB = 2048;
const GHOSTSCRIPT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const GHOSTSCRIPT_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 300;
const PDF_EOF_MARKER = '%%EOF';
const EOF_SEARCH_BYTES = 1024;

/** qpdf arguments of the lossless profile. */
const LOSSLESS_QPDF_ARGS: readonly string[] = [
  '--object-streams=generate',
  '--compress-streams=y',
  '--recompress-flate',
  '--compression-level=9',
];

export interface PdfCompressRun {
  /** Fires at the job deadline, on cancel and on takeover; Ghostscript is stopped when it does. */
  signal?: AbortSignal;
  /** Milliseconds left until the job deadline; the run is held to it. */
  remainingMs?: number;
}

export interface PdfCompressResult {
  buffer: Buffer;
  /** False when the profile gained nothing and `buffer` is the input. */
  optimized: boolean;
}

function resolveProfile(options: PdfOptimizeOptions | undefined): PdfOptimizeProfile {
  const profile = options?.profile ?? DEFAULT_PDF_OPTIMIZE_PROFILE;
  if (!PDF_OPTIMIZE_PROFILES.includes(profile)) {
    throw new UnsupportedOptionError(`The PDF optimize profile must be one of ${PDF_OPTIMIZE_PROFILES.join(', ')}; got ${JSON.stringify(profile)}.`);
  }
  return profile;
}

function toGhostscriptError(error: unknown, dir: string): unknown {
  if (error instanceof SandboxedBufferLimitError) {
    return new PdfPostprocessError('Compression failed: the result exceeds the allowed size.');
  }
  if (error instanceof SandboxedTimeoutError) {
    return new PdfPostprocessError('Compression failed: it took longer than the time allowed.');
  }
  if (!(error instanceof SandboxedProcessError)) return error;
  const detail = `${error.stderr}${error.stdout}`.replaceAll(dir, '<tmp>').trim().split('\n')[0]?.slice(0, MAX_DIAGNOSTIC_CHARS) ?? '';
  const reason = detail ? ` (${detail})` : '';
  return new PdfPostprocessError(`Compression failed: Ghostscript could not process the document${reason}.`);
}

async function rewriteWithGhostscript(pdf: Buffer, preset: string, run: PdfCompressRun): Promise<Buffer> {
  const gs = getGhostscriptBinaryPath();
  if (!gs) {
    throw new EngineUnavailableError('ghostscript', 'Ghostscript (gs) is not installed or not in PATH');
  }
  return withQpdfWorkspace(pdf, async (workspace) => {
    const outputPath = path.join(workspace.dir, GHOSTSCRIPT_OUTPUT_NAME);
    const timeoutMs = Math.min(GHOSTSCRIPT_DEFAULT_TIMEOUT_MS, run.remainingMs ?? GHOSTSCRIPT_DEFAULT_TIMEOUT_MS);
    try {
      await executeSandboxedBinary(gs, [...GHOSTSCRIPT_FIXED_ARGS, `-dPDFSETTINGS=${preset}`, `-sOutputFile=${outputPath}`, workspace.inputPath], {
        cwd: workspace.dir,
        timeoutMs,
        maxBuffer: GHOSTSCRIPT_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: GHOSTSCRIPT_MAX_OUTPUT_BYTES,
        memoryLimitMb: GHOSTSCRIPT_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: run.signal,
      });
    } catch (error) {
      throw toGhostscriptError(error, workspace.dir);
    }
    const output = fs.readFileSync(outputPath);
    const tail = output.subarray(Math.max(0, output.length - EOF_SEARCH_BYTES)).toString('latin1');
    if (!output.subarray(0, 5).equals(Buffer.from('%PDF-')) || !tail.includes(PDF_EOF_MARKER)) {
      throw new PdfPostprocessError('Compression failed: Ghostscript wrote an incomplete document.');
    }
    return output;
  });
}

async function rewriteLossless(pdf: Buffer): Promise<Buffer> {
  return withQpdfInputFile(pdf, (workspace) =>
    runQpdfToBuffer(workspace, { args: [...LOSSLESS_QPDF_ARGS, workspace.inputPath, '-'], action: 'Compression' })
  );
}

/**
 * Compresses `pdf` with the profile of `options.profile` (`web` when omitted).
 *
 * @throws UnsupportedOptionError for a profile that does not exist.
 * @throws EngineUnavailableError when the profile needs Ghostscript and it is not installed.
 * @throws PdfPostprocessError when the engine cannot process the document or writes an incomplete one.
 */
export async function compressPdf(
  pdf: Buffer,
  options: PdfOptimizeOptions | undefined,
  access: PdfAccess = {},
  run: PdfCompressRun = {}
): Promise<PdfCompressResult> {
  const profile = resolveProfile(options);
  if (!pdf || pdf.length === 0) {
    throw new PdfPostprocessError('PDF buffer is empty.');
  }
  assertPdfHeader(pdf);
  const plain = await openPdfForEditing(pdf, 'compress', access);
  const preset = GHOSTSCRIPT_PRESETS[profile];
  const rewritten = preset === undefined ? await rewriteLossless(plain) : await rewriteWithGhostscript(plain, preset, run);
  // The input as it came is the baseline and what is returned when nothing is gained.
  return rewritten.length < pdf.length ? { buffer: rewritten, optimized: true } : { buffer: pdf, optimized: false };
}
