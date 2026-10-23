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
import { launchSandboxedBinary } from '../../security/sandbox-launcher';
import { executeSandboxedBinary } from '../../../worker/sandbox';
import { pdfFromHeader } from '../../format-signatures';
import { assertPdfHeader } from '../pdf-text-document';
import { openPdfForEditing, type PdfAccess } from '../pdf-access';
import { getGhostscriptBinaryPath } from './gs-path';
import { qpdfListsPages, repairPageTree } from './page-tree';
import { QPDF_RUN_TIMEOUT_MS, runQpdfToBuffer, withQpdfInputFile, withQpdfWorkspace } from './qpdf-run';

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
 * An encrypted input goes through the same gate as every other PDF edit (see pdf-access). A page tree that reaches one
 * of its own nodes a second time is mended first (see page-tree): Ghostscript cannot walk such a tree and writes a blank
 * page for what it cannot reach, and qpdf's lossless rewrite would keep the loop.
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
/** `-P-` keeps the working directory, which holds the input, out of the library search first, as the `ps2pdf` scripts (`ps2pdfwr`) pass it. */
const GHOSTSCRIPT_FIXED_ARGS: readonly string[] = [
  '-P-',
  '-q',
  '-dNOPAUSE',
  '-dBATCH',
  '-dSAFER',
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

async function rewriteWithGhostscript(pdf: Buffer, preset: string, run: PdfCompressRun, signal: AbortSignal | undefined): Promise<Buffer> {
  const gs = getGhostscriptBinaryPath();
  if (!gs) {
    throw new EngineUnavailableError('ghostscript', 'Ghostscript (gs) is not installed or not in PATH');
  }
  // Ghostscript runs a file as PostScript or as PDF by its first bytes and does not look for the header, so it gets the file from the header on.
  return withQpdfWorkspace(pdfFromHeader(pdf), async (workspace) => {
    const outputPath = path.join(workspace.dir, GHOSTSCRIPT_OUTPUT_NAME);
    const timeoutMs = Math.min(GHOSTSCRIPT_DEFAULT_TIMEOUT_MS, run.remainingMs ?? GHOSTSCRIPT_DEFAULT_TIMEOUT_MS);
    try {
      await launchSandboxedBinary(gs, [...GHOSTSCRIPT_FIXED_ARGS, `-dPDFSETTINGS=${preset}`, `-sOutputFile=${outputPath}`, workspace.inputPath], {
        cwd: workspace.dir,
        timeoutMs,
        maxBuffer: GHOSTSCRIPT_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: GHOSTSCRIPT_MAX_OUTPUT_BYTES,
        memoryLimitMb: GHOSTSCRIPT_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal,
        // Ghostscript writes the document to a file and prints diagnostics only.
        expectedOutputBytes: 0,
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

async function rewriteLossless(pdf: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return withQpdfInputFile(pdf, (workspace) =>
    runQpdfToBuffer(workspace, { args: [...LOSSLESS_QPDF_ARGS, workspace.inputPath, '-'], action: 'Compression', signal })
  );
}

/** The rewrite the profile asks for, of `pdf`; `signal` stops it. */
type Rewrite = (pdf: Buffer, signal: AbortSignal | undefined) => Promise<Buffer>;

/**
 * `rewrite` of `opened`, with the question whether qpdf can list its pages asked beside it. A document whose page tree
 * loops is mended first (see page-tree): Ghostscript cannot walk such a tree and writes a blank page for what it cannot
 * reach, and qpdf's lossless rewrite would keep the loop. Only such a document discards the first rewrite and rewrites
 * the mended tree, so a healthy one waits for the rewrite alone: the question is a qpdf run of a few milliseconds beside a rewrite of tens.
 */
async function rewriteMendingPageTree(opened: Buffer, rewrite: Rewrite, run: PdfCompressRun): Promise<{ plain: Buffer; rewritten: Buffer }> {
  const stop = new AbortController();
  const rewriting = rewrite(opened, run.signal ? AbortSignal.any([run.signal, stop.signal]) : stop.signal);
  // A rewrite that is stopped, or fails while the question is awaited, must not surface as an unhandled rejection.
  rewriting.catch(() => undefined);
  const listed = await qpdfListsPages(opened, run.signal).catch((error: unknown) => {
    stop.abort();
    throw error;
  });
  if (listed) return { plain: opened, rewritten: await rewriting };
  const mended = await repairPageTree(opened, { knownLooping: true });
  if (mended === opened) return { plain: opened, rewritten: await rewriting };
  stop.abort();
  // The stopped run has ended, and with it the files of its directory, before the next one starts.
  await rewriting.catch(() => undefined);
  return { plain: mended, rewritten: await rewrite(mended, run.signal) };
}

/** Whether `pdf` already passes `qpdf --check` without structural warnings or errors. */
async function isCleanPdf(pdf: Buffer): Promise<boolean> {
  return withQpdfInputFile(pdf, async (workspace) => {
    try {
      await executeSandboxedBinary(workspace.qpdf, ['--check', workspace.inputPath], {
        cwd: workspace.dir,
        timeoutMs: QPDF_RUN_TIMEOUT_MS,
        maxBuffer: GHOSTSCRIPT_MAX_DIAGNOSTIC_BYTES,
        networkIsolated: true,
      });
      return true;
    } catch {
      return false;
    }
  });
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
  const preset = GHOSTSCRIPT_PRESETS[profile];
  const rewrite: Rewrite = preset === undefined ? rewriteLossless : (input, signal) => rewriteWithGhostscript(input, preset, run, signal);
  const { plain, rewritten } = await rewriteMendingPageTree(await openPdfForEditing(pdf, 'compress', access), rewrite, run);
  if (rewritten.length < pdf.length) {
    return { buffer: rewritten, optimized: true };
  }
  // When the profile gained nothing, return the input (with its page tree mended, if it needed that) if it is already a clean PDF; if the input has
  // damaged cross-references or streams that qpdf --check flags, fall back to the lossless qpdf rewrite so the
  // returned PDF is valid (and smaller when object streams pack a text-only document better than pdfwrite).
  if (await isCleanPdf(plain)) {
    return { buffer: plain, optimized: false };
  }
  const repaired = preset === undefined ? rewritten : await rewriteLossless(plain);
  const best = repaired.length <= rewritten.length ? repaired : rewritten;
  return { buffer: best, optimized: best.length < pdf.length };
}
