import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_SECURITY_LIMITS } from '../lib/conversions/archive';
import type { ArchiveExtractionLimits } from '../lib/conversions/archive-extraction-safety';
import { readZipDirectory, readZipEntries } from '../lib/conversions/archive-zip-reader';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../lib/conversions/bounded-inflate';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { renderedXpsPageParts } from '../lib/conversions/office/xps-reader';
import { partKey, requirePagesDrawable } from '../lib/conversions/office/xps-resources';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../lib/conversions/page-range';
import { writeZipFile } from '../lib/conversions/zip-writer';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../lib/types';
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
 * document limits of the XPS reader, before it starts: every page the documents list must be in the package, and the
 * images and colour profiles the pages name, counted again for every page that names them, stay within the document
 * budget of xps-resources.ts.
 *
 * GhostXPS reports a document it could not draw on its error output and still exits with success, after writing a PDF of
 * the pages it reached (GhostPDL pcl/pl/plmain.c `pl_main_run_file_utf8`, "Warning interpreter exited with error code"),
 * so that line is a failure here. A PDF is also a failure unless it holds as many pages as the documents list, whatever
 * the program printed, so a partial PDF is never handed out.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** The address space, output file size and output pipe limits of the PostScript interpreter, which does the same work. */
const MEMORY_LIMIT_MB = 2048;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
/**
 * The most bytes of drawn PDF that an image target reads into memory for the PDF tools, which take a buffer: half the
 * inflate budget of the package, whose parts are held at the same time (the output limit would add up to twice that budget
 * on top of them). A PDF target hands the file on by its path and is bound by MAX_OUTPUT_BYTES only.
 */
const MAX_PDF_BYTES_READ_FOR_IMAGES = MAX_DOCUMENT_INFLATE_BYTES / 2;
/** Run time and ceiling of counting the pages of the drawn PDF, as for the other Poppler tools. */
const PAGE_COUNT_DEFAULT_TIMEOUT_MS = 45_000;
const PAGE_COUNT_MAX_TIMEOUT_MS = 120_000;
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
  /** The number of pages of a PDF file, counted by the PDF tools without reading the file into memory. */
  countPdfPages: (pdfPath: string, tempDir: string, timeoutMs: number, signal?: AbortSignal) => Promise<number>;
}

interface PackageEntry {
  filename: string;
  buffer: Buffer;
}

/** The entries of the package, inflated within the limits; a part named twice (XPS part names ignore case) is refused. */
async function readPackageEntries(input: Buffer): Promise<PackageEntry[]> {
  const entries = await readZipEntries(input, readZipDirectory(input, XPS_PACKAGE_LIMITS), { limits: XPS_PACKAGE_LIMITS });
  const names = new Set<string>();
  for (const { filename } of entries) {
    const key = partKey(filename);
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

/** What the PDF may be: the most bytes it may have and the number of pages the documents list. */
interface PdfExpectation {
  maxBytes: number;
  pageCount: number;
}

async function writePdf(job: XpsJob, entries: readonly PackageEntry[], tempDir: string, expected: PdfExpectation): Promise<string> {
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
  const size = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
  if (size === 0) throw new ConversionFailedError(`GhostXPS drew no page from the .${job.src} file.`);
  if (size > expected.maxBytes) throw new PayloadLimitError(`GhostXPS drew ${size} bytes of PDF from the .${job.src} file, more than the ${expected.maxBytes} bytes that can be taken further.`);
  const pageTimeoutMs = Math.min(stageTimeoutMs(job.options, PAGE_COUNT_DEFAULT_TIMEOUT_MS), PAGE_COUNT_MAX_TIMEOUT_MS);
  const drawn = await job.countPdfPages(pdfPath, tempDir, pageTimeoutMs, job.options.signal);
  if (drawn !== expected.pageCount) {
    throw new ConversionFailedError(`GhostXPS drew ${drawn} of the ${expected.pageCount} pages that the .${job.src} file lists.`);
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
  const pageParts = await renderedXpsPageParts(bytes, options.signal);
  const pageCount = pageParts.length;
  const pageOptions: WorkerEngineOptions = { ...options, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES };
  if (tgt !== PDF_TARGET && !selectsPages(options)) {
    boundRenderedPages(
      Array.from({ length: pageCount }, (_, index) => index + 1),
      pageOptions
    );
  }
  requirePagesDrawable(pageParts, new Map(entries.map(({ filename, buffer }) => [partKey(filename), buffer])), options.signal);

  if (tgt === PDF_TARGET) {
    return withSandboxDir(TEMP_PREFIX, async (tempDir) => {
      const pdfPath = await writePdf(job, entries, tempDir, { maxBytes: MAX_OUTPUT_BYTES, pageCount });
      const persistedPath = handOffOutput(pdfPath, PDF_TARGET, options, Buffer.isBuffer(input) ? undefined : input);
      return createConversionResult(persistedPath, PDF_TARGET, baseNameOf(job), 'native-xps', Date.now() - startTime);
    });
  }
  const pdf = await withSandboxDir(TEMP_PREFIX, async (tempDir) =>
    fs.readFileSync(await writePdf(job, entries, tempDir, { maxBytes: MAX_PDF_BYTES_READ_FOR_IMAGES, pageCount }))
  );
  return job.convertPdfPages(pdf, tgt, pageOptions, originalFilename);
}
