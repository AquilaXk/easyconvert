import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_SECURITY_LIMITS } from '../lib/conversions/archive';
import type { ArchiveExtractionLimits } from '../lib/conversions/archive-extraction-safety';
import { readZipDirectory, readZipEntries } from '../lib/conversions/archive-zip-reader';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../lib/conversions/bounded-inflate';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { countRenderedXpsPages } from '../lib/conversions/office/xps-reader';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../lib/conversions/page-range';
import { writeZipFile } from '../lib/conversions/zip-writer';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { ConversionFailedError, CorruptStreamError } from '../lib/types';
import { boundRenderedPages, selectsPages } from './poppler-ppm';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError } from './sandbox';
import { createConversionResult, handOffOutput, readRawInputBuffer, withSandboxDir } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

/**
 * XPS and OpenXPS documents are drawn by GhostXPS (`gxps` of GhostPDL, AGPL-3.0, an unmodified separate program) into a
 * PDF, which the native PDF tools take to every page target, as a PostScript file is drawn by Ghostscript.
 *
 * GhostXPS trusts the package: it inflates each part into a buffer of the size the central directory states, with no
 * limit on the parts, their total or the compression ratio, and it reads no ZIP64 record (a ZIP64 size is a negative
 * number to it, GhostPDL xps/xpszip.c `xps_read_zip_dir`). So the package is read here first, under the archive limits
 * of the conversion (the entry count and the compression ratio of `ARCHIVE_SECURITY_LIMITS`, the 256 MiB inflate budget
 * of one document), every entry checked against its CRC, and written again as a plain stored ZIP in the job directory:
 * the program sees only a package written here. The pages are counted the way GhostXPS finds them, under the page and
 * document limits of the XPS reader, before it starts.
 *
 * GhostXPS reports a document it could not draw on its error output and still exits with success, after writing a PDF of
 * the pages it reached (GhostPDL pcl/pl/plmain.c `pl_main_run_file_utf8`, "Warning interpreter exited with error code"),
 * so that line is a failure here.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** The address space, output file size and output pipe limits of the PostScript interpreter, which does the same work. */
const MEMORY_LIMIT_MB = 2048;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
/** The program writes its result to a file in the job directory and prints nothing the worker has to copy. */
const NO_PIPED_OUTPUT_BYTES = 0;
const XPS_PACKAGE_LIMITS: ArchiveExtractionLimits = {
  MAX_FILES: ARCHIVE_SECURITY_LIMITS.MAX_FILES,
  MAX_UNCOMPRESSED_SIZE: MAX_DOCUMENT_INFLATE_BYTES,
  MAX_RATIO: ARCHIVE_SECURITY_LIMITS.MAX_RATIO,
};
/**
 * GhostPDL pcl/pl/plmain.c: `-q` is accepted as QUIET, `-dNOPAUSE` turns the page prompt off, and the output file is added
 * to the paths it may write. Safe mode is its default (`minst->safer = true`; only `-dNOSAFER` turns it off): after the
 * arguments, path control is active, and the input may be read only while it is being drawn.
 */
const RENDERER_FLAGS: readonly string[] = ['-q', '-dNOPAUSE', '-sDEVICE=pdfwrite'];
const RENDERER_FAILURE_PATTERN = /Warning interpreter exited with error code/;
const PDF_TARGET = 'pdf';
const TEMP_PREFIX = 'easyconvert-xps-';
/** The package's name in the job directory; GhostXPS reads a file whose name holds `.fpage` or `/_rels/.rels` as loose parts of a folder instead. */
const PACKAGE_FILE = 'document.xps';
const PDF_FILE = 'rendered.pdf';

export interface XpsJob {
  /** The request's input, whose output path the PDF is handed to. */
  input: Buffer | WorkerVfsPayload;
  /** `xps` or `oxps`. */
  src: string;
  tgt: string;
  options: WorkerEngineOptions;
  originalFilename: string;
  /** The `gxps` program. */
  interpreter: string;
  /** Hands a PDF to the native PDF tools (Poppler images and SVG, the encoded rasters, pdftops). */
  convertPdfPages: (pdf: Buffer, tgt: string, options: WorkerEngineOptions, originalFilename: string) => Promise<WorkerConversionResult | null>;
}

/** The entries of the package, inflated within the limits; a part named twice (XPS part names ignore case) is refused. */
async function readPackageEntries(input: Buffer): Promise<{ filename: string; buffer: Buffer }[]> {
  const entries = await readZipEntries(input, readZipDirectory(input, XPS_PACKAGE_LIMITS), { limits: XPS_PACKAGE_LIMITS });
  const names = new Set<string>();
  for (const { filename } of entries) {
    const key = filename.toLowerCase();
    if (names.has(key)) throw new CorruptStreamError(`The XPS package holds the part "${filename}" more than once.`);
    names.add(key);
  }
  return entries;
}

/** The typed error for a run that failed: its limits, or what the program printed about the file. */
function toRendererError(err: unknown, src: string, tempDir: string): unknown {
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`GhostXPS exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) return rejected(src, err.stderr, tempDir);
  return err;
}

function rejected(src: string, stderr: string, tempDir: string): ConversionFailedError {
  const detail = stderr.trim().slice(0, MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>');
  return new ConversionFailedError(`GhostXPS could not draw the .${src} file${detail ? `: ${detail}` : ''}`);
}

async function writePdf(job: XpsJob, entries: readonly { filename: string; buffer: Buffer }[], tempDir: string): Promise<string> {
  const packagePath = path.join(tempDir, PACKAGE_FILE);
  const pdfPath = path.join(tempDir, PDF_FILE);
  await writeZipFile(packagePath, entries.map(({ filename, buffer }) => ({ name: filename, data: buffer, method: 'store' as const })));
  const limits: LaunchedExecutionOptions = {
    timeoutMs: Math.min(stageTimeoutMs(job.options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS),
    maxBuffer: job.options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
    maxFileSize: MAX_OUTPUT_BYTES,
    memoryLimitMb: MEMORY_LIMIT_MB,
    networkIsolated: true,
    signal: job.options.signal,
    cwd: tempDir,
    expectedOutputBytes: NO_PIPED_OUTPUT_BYTES,
  };
  let stderr: string;
  try {
    const run = await launchSandboxedBinary(job.interpreter, [...RENDERER_FLAGS, `-sOutputFile=${pdfPath}`, packagePath], limits);
    stderr = run.stderr.toString('utf-8');
  } catch (err) {
    throw toRendererError(err, job.src, tempDir);
  }
  if (RENDERER_FAILURE_PATTERN.test(stderr)) throw rejected(job.src, stderr, tempDir);
  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
    throw new ConversionFailedError(`GhostXPS drew no page from the .${job.src} file.`);
  }
  return pdfPath;
}

function baseNameOf(job: XpsJob): string {
  return job.originalFilename ? job.originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
}

/**
 * Draws an XPS or OpenXPS document as a PDF and, for page targets, hands the PDF to the native PDF tools with the page limit of
 * the other document page chains. A request for the images of every page of a document longer than that limit is refused
 * before the document is drawn.
 */
export async function convertXps(job: XpsJob): Promise<WorkerConversionResult | null> {
  const { input, tgt, options, originalFilename } = job;
  const bytes = readRawInputBuffer(input);
  const startTime = Date.now();
  const entries = await readPackageEntries(bytes);
  const pageCount = await countRenderedXpsPages(bytes, options.signal);
  const pageOptions: WorkerEngineOptions = { ...options, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES };
  if (tgt !== PDF_TARGET && !selectsPages(options)) {
    boundRenderedPages(
      Array.from({ length: pageCount }, (_, index) => index + 1),
      pageOptions
    );
  }

  if (tgt === PDF_TARGET) {
    return withSandboxDir(TEMP_PREFIX, async (tempDir) => {
      const pdfPath = await writePdf(job, entries, tempDir);
      const persistedPath = handOffOutput(pdfPath, PDF_TARGET, options, Buffer.isBuffer(input) ? undefined : input);
      return createConversionResult(persistedPath, PDF_TARGET, baseNameOf(job), 'native-xps', Date.now() - startTime);
    });
  }
  const pdf = await withSandboxDir(TEMP_PREFIX, async (tempDir) => fs.readFileSync(await writePdf(job, entries, tempDir)));
  return job.convertPdfPages(pdf, tgt, pageOptions, originalFilename);
}
