import fs from 'node:fs';
import path from 'node:path';
import { checkDjvuContainer } from '../lib/conversions/djvu-container';
import { DJVUSED_DIRECTORY_SCRIPT, DJVUSED_MAX_OUTPUT_BYTES, DJVUSED_SIZE_SCRIPT, parseDjvusedPageCount, parseDjvusedSizes } from '../lib/conversions/djvu-report';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { groupConsecutiveRanges, OFFICE_PAGE_IMAGE_MAX_PAGES, resolvePageSelection } from '../lib/conversions/page-range';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { ConversionFailedError, CpuTaskTimeoutError, EngineUnavailableError, InvalidPageRangeError } from '../lib/types';
import { boundRenderedPages } from './poppler-ppm';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from './sandbox';
import { createConversionResult, drawnPdfTooLargeError, handOffOutput, MAX_DRAWN_PDF_BYTES_FOR_IMAGES, readRawInputBuffer, withSandboxDir } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions } from './worker-types';
import type { XpsJob } from './xps-render';

/**
 * DjVu documents are drawn by `ddjvu` of djvulibre (GPL-2.0-or-later, an unmodified separate program from the
 * `djvulibre-bin` package) into a PDF, which the native PDF tools take to every page target, as GhostXPS's PDF is taken.
 * The program decodes each page (IW44 wavelet background, JB2 bilevel mask, foreground colours) to a raster and writes
 * it with libtiff into a temporary TIFF beside the output, which `tiff2pdf` (compiled into the program,
 * tools/ddjvu.cpp `closefile`, lines 646 to 700) turns into a PDF of one image per page. The PDF holds no text layer; the
 * hidden text of the DjVu file is not carried into it, as the program does not carry it.
 *
 * The file is read for its structure first. The bytes are checked in djvu-container.ts (a document that names other files is
 * refused, because the program would read them from the directory of the file, libdjvu/DjVuDocument.cpp line 1531), then
 * `djvused` of the same package, run in the same sandbox on the same file, reports the page count (djvu-report.ts), so that what
 * the converter counts is what `ddjvu` draws, and a second run reports the page sizes, so that what the converter limits is what
 * `ddjvu` draws. The second run opens every page and creates the files the pages include, as `ddjvu` does, and crashes on a
 * document whose includes form a cycle or run thousands of files deep (a stack overflow, signal 11); its crash, a status other
 * than zero or its time limit refuses the document as one whose include structure the program cannot open, so djvulibre itself
 * judges the include graph, in the sandbox, and the worker holds no model of it. All three programs run before the output exists,
 * in a directory of their own that holds the one file and the output, in the sandbox, without network, and share the one
 * deadline of the job (`DjvuRun`): a document costs at most the stage limit, 120 s by default, whatever its includes.
 *
 * The program stops at the first page it cannot decode, with a message and the exit status 10 (tools/ddjvu.cpp
 * `dopage`, lines 728 to 746, unless `-skip` is given, which is not), so a truncated or damaged page is a failure here and
 * never a PDF with a missing page. A PDF is also a failure unless it holds as many pages as the document lists.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/**
 * Address space, output file size and output pipe limits of the other page chains (xps-render.ts, postscript-render.ts). Measured with
 * ddjvu 3.5.28 under an address space limit of 2 GiB: a 100 megapixel colour page (the pixel limit of the image inputs) peaks at
 * 672 MB resident and writes 145 MB of PDF in 5.6 s on the 4 vCPU Linux arm64 test VM.
 */
const MEMORY_LIMIT_MB = 2048;
/**
 * The size limit of one file the program writes. It writes two: the temporary TIFF of every page, which `tiff2pdf` then turns
 * into the PDF, and the PDF, each under this limit. The TIFF of a colour page is about as large as the page's PDF image, so
 * the limit is met by the pages together: see entry 134 of docs/policy-decisions.md for what it allows.
 */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
/** The page count of the drawn PDF, the limit of the other page chains, held to the deadline of the job. */
const PAGE_COUNT_TIMEOUT_MS = 45_000;
/**
 * Each `djvused` run. Its cost is that of the directory, which grows with the square of its files: the largest directory taken
 * (10,000 pages and 10,000 shared files) takes 4.3 s for `n;ls` and 4.7 s for `size` with 3.5.28 on the 4 vCPU Linux arm64 test
 * VM (5.3 s with 3.5.29 on Apple silicon), and the crash on a cycle or a deep chain comes within 1.2 s. The limit is six times
 * the largest, and a run past it is refused (entry 134 of docs/policy-decisions.md).
 */
const REPORT_TIMEOUT_MS = 30_000;
/** What the report of a document of a few hundred pages comes to; the launcher helper copies it back. */
const REPORT_EXPECTED_OUTPUT_BYTES = 64 * 1024;
const REPORT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
/** The program writes its result to a file in the job directory and prints nothing the worker has to copy. */
const NO_PIPED_OUTPUT_BYTES = 0;
/** `ddjvu -format=pdf [-page=<pages>] <input> <output>`: the scale and the quality are left at the defaults (full page size, deflate). */
const FORMAT_FLAG = '-format=pdf';
const PDF_TARGET = 'pdf';
const TEMP_PREFIX = 'easyconvert-djvu-';
const INPUT_FILE = 'document.djvu';
const PDF_FILE = 'rendered.pdf';
const REPORT_PROGRAM = 'djvused';
const RENDER_PROGRAM = 'ddjvu';

/** The same job as GhostXPS's: the request, the program, and the PDF tools the drawn file is handed to. */
export type DjvuJob = Pick<XpsJob, 'input' | 'src' | 'tgt' | 'options' | 'originalFilename' | 'interpreter' | 'convertPdfPages' | 'countPdfPages'>;

/**
 * The drawing of one document: the file in its job directory and the one deadline that the `djvused` runs, `ddjvu` and the page count
 * of its PDF share, each given what is left of it (at most its own limit).
 */
interface DjvuRun {
  readonly job: DjvuJob;
  readonly tempDir: string;
  readonly inputPath: string;
  readonly limitMs: number;
  readonly deadlineAt: number;
}

/** A document whose pages `djvused` cannot open: the program crashed, failed or ran past its limit creating the files they include. */
class DjvuIncludeStructureError extends ConversionFailedError {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'DjvuIncludeStructureError';
  }
}

/** The pages the program draws and the limit on the PDF it writes. */
interface DrawPlan {
  /** The `-page` argument, or undefined for every page. */
  readonly pageSpec: string | undefined;
  readonly pageCount: number;
  readonly maxBytes: number;
}

/** The run limit of the job: its own stage limit, or the default, and never more than the ceiling. */
function runTimeoutMs(options: WorkerEngineOptions): number {
  return Math.min(stageTimeoutMs(options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** The start of what a program printed about the file, with the job directory hidden. */
function stderrDetail(stderr: string, tempDir: string): string {
  return stderr.trim().slice(0, MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>');
}

function rejected(program: string, src: string, stderr: string, tempDir: string): ConversionFailedError {
  const detail = stderrDetail(stderr, tempDir);
  return new ConversionFailedError(`${program} could not ${program === RENDER_PROGRAM ? 'draw' : 'read'} the .${src} file${detail ? `: ${detail}` : ''}`);
}

/** The typed error for a run that failed: its limits, or what the program printed about the file. */
function toRendererError(err: unknown, program: string, src: string, tempDir: string): unknown {
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`${program} exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) return rejected(program, src, err.stderr, tempDir);
  return err;
}

/** What is left of the deadline of the run, at most `ownLimitMs`; a run that has used all of its time starts nothing more. */
function remainingMs(run: DjvuRun, ownLimitMs: number): number {
  const remaining = run.deadlineAt - Date.now();
  if (remaining <= 0) throw new CpuTaskTimeoutError(`.${run.job.src} to .${run.job.tgt} conversion`, run.limitMs);
  return Math.min(ownLimitMs, remaining);
}

function sandboxLimits(run: DjvuRun, limits: Pick<LaunchedExecutionOptions, 'timeoutMs' | 'maxBuffer' | 'maxFileSize' | 'expectedOutputBytes'>): LaunchedExecutionOptions {
  return { memoryLimitMb: MEMORY_LIMIT_MB, networkIsolated: true, signal: run.job.options.signal, cwd: run.tempDir, ...limits };
}

/** `djvused` ships in the package of `ddjvu` and sits next to it. */
function reportProgramOf(job: DjvuJob): string {
  const program = path.join(path.dirname(job.interpreter), REPORT_PROGRAM);
  if (!fs.existsSync(program)) throw new EngineUnavailableError(REPORT_PROGRAM, `${REPORT_PROGRAM} (djvulibre-bin) is not installed next to ${RENDER_PROGRAM}`);
  return program;
}

/** What `script` of `djvused` prints for the document, in the sandbox. */
async function runReport(run: DjvuRun, script: string): Promise<string> {
  const program = reportProgramOf(run.job);
  const limits = sandboxLimits(run, {
    timeoutMs: remainingMs(run, REPORT_TIMEOUT_MS),
    maxBuffer: DJVUSED_MAX_OUTPUT_BYTES,
    maxFileSize: REPORT_MAX_FILE_BYTES,
    expectedOutputBytes: REPORT_EXPECTED_OUTPUT_BYTES,
  });
  const report = await launchSandboxedBinary(program, ['-e', script, run.inputPath], limits);
  return report.stdout.toString('utf-8');
}

/** The page count `djvused -e 'n;ls'` reports, under the page limit. */
async function readPageCount(run: DjvuRun): Promise<number> {
  try {
    return parseDjvusedPageCount(await runReport(run, DJVUSED_DIRECTORY_SCRIPT));
  } catch (err) {
    throw toRendererError(err, REPORT_PROGRAM, run.job.src, run.tempDir);
  }
}

/**
 * How a `size` run that did not open the pages ended, or undefined for a failure that is not the document's: the deadline of the
 * job, a program that did not start, an output over its limit. The sandbox reports a segmentation fault under the address space
 * limit as the memory limit (process-sandbox.ts), which is how the stack overflow of a deep or cyclic include graph arrives.
 */
function failedSizeRun(err: unknown, tempDir: string): string | undefined {
  if (err instanceof SandboxedTimeoutError) return err.timeoutMs >= REPORT_TIMEOUT_MS ? `ran past its ${REPORT_TIMEOUT_MS} ms limit` : undefined;
  if (err instanceof SandboxedMemoryLimitError) return `crashed or ran out of its ${err.limitMb} MB memory limit`;
  if (!(err instanceof SandboxedProcessError) || err.spawnErrorCode !== undefined) return undefined;
  if (err.signal !== null) return `crashed (${err.signal})`;
  const detail = stderrDetail(err.stderr, tempDir);
  return `exited with status ${err.exitCode}${detail ? `: ${detail}` : ''}`;
}

/**
 * Checks the size of every page against the pixel limit: `ddjvu` draws each page at its own size. The run opens the pages and the
 * files they include, so its failure refuses the document before `ddjvu` starts on it.
 */
async function checkPageSizes(run: DjvuRun, pageCount: number): Promise<void> {
  let output: string;
  try {
    output = await runReport(run, DJVUSED_SIZE_SCRIPT);
  } catch (err) {
    const failure = failedSizeRun(err, run.tempDir);
    if (failure === undefined) throw toRendererError(err, REPORT_PROGRAM, run.job.src, run.tempDir);
    throw new DjvuIncludeStructureError(
      `The DjVu document's include structure is too deep, cyclic or damaged: djvused could not open its pages and ${failure}.`
    );
  }
  parseDjvusedSizes(output, pageCount);
}

/** The pages as the `-page` argument of the program: `3-5,8`. */
function pageSpecOf(pages: readonly number[]): string {
  return groupConsecutiveRanges([...pages]).map(({ start, end }) => (start === end ? String(start) : `${start}-${end}`)).join(',');
}

/** The request without its page selection, for the PDF of only the selected pages. */
function withoutPageSelection(options: WorkerEngineOptions): WorkerEngineOptions {
  return { ...options, page: undefined, pages: undefined };
}

/**
 * What to draw. A PDF target is every page. A page target is the pages the request selects, at most as many as the other page
 * chains render in one request (the whole document when none is selected), so that a long document is not drawn for one page.
 */
function drawPlanOf(job: DjvuJob, pageCount: number): DrawPlan {
  if (job.tgt === PDF_TARGET) return { pageSpec: undefined, pageCount, maxBytes: MAX_OUTPUT_BYTES };
  const selected =
    resolvePageSelection(job.options.page, job.options.pages, pageCount, (page, count) => new InvalidPageRangeError(`Page number ${page} is out of bounds (1-${count})`)) ??
    Array.from({ length: pageCount }, (_, index) => index + 1);
  const drawn = boundRenderedPages(selected, { ...job.options, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES });
  return { pageSpec: drawn.length === pageCount ? undefined : pageSpecOf(drawn), pageCount: drawn.length, maxBytes: MAX_DRAWN_PDF_BYTES_FOR_IMAGES };
}

async function writePdf(run: DjvuRun, plan: DrawPlan): Promise<string> {
  const { job, tempDir, inputPath } = run;
  const pdfPath = path.join(tempDir, PDF_FILE);
  const limits = sandboxLimits(run, {
    timeoutMs: remainingMs(run, run.limitMs),
    maxBuffer: job.options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
    maxFileSize: MAX_OUTPUT_BYTES,
    expectedOutputBytes: NO_PIPED_OUTPUT_BYTES,
  });
  const pageArguments = plan.pageSpec === undefined ? [] : [`-page=${plan.pageSpec}`];
  try {
    await launchSandboxedBinary(job.interpreter, [FORMAT_FLAG, ...pageArguments, inputPath, pdfPath], limits);
  } catch (err) {
    throw toRendererError(err, RENDER_PROGRAM, job.src, tempDir);
  }
  const size = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
  if (size === 0) throw new ConversionFailedError(`ddjvu drew no page from the .${job.src} file.`);
  if (size > plan.maxBytes) throw drawnPdfTooLargeError('ddjvu', job.src, size, plan.maxBytes);
  const drawn = await job.countPdfPages(pdfPath, tempDir, remainingMs(run, PAGE_COUNT_TIMEOUT_MS), job.options.signal);
  if (drawn !== plan.pageCount) {
    throw new ConversionFailedError(`ddjvu drew ${drawn} of the ${plan.pageCount} pages that the .${job.src} file lists.`);
  }
  return pdfPath;
}

function baseNameOf(job: DjvuJob): string {
  return job.originalFilename ? job.originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
}

/**
 * Draws a DjVu document as a PDF and, for page targets, hands the PDF to the native PDF tools with the page limit of the
 * other document page chains. A request for the images of more pages than that limit, of every page of a long document or of a
 * long selection, is refused before anything is drawn. A selection is drawn alone (`ddjvu -page`), so the PDF holds the
 * selected pages and nothing else.
 */
export async function convertDjvu(job: DjvuJob): Promise<WorkerConversionResult | null> {
  const { input, tgt, options, originalFilename } = job;
  const bytes = readRawInputBuffer(input);
  const startTime = Date.now();
  checkDjvuContainer(bytes);
  const draw = async (tempDir: string): Promise<string> => {
    const inputPath = path.join(tempDir, INPUT_FILE);
    fs.writeFileSync(inputPath, bytes, { mode: 0o600 });
    const limitMs = runTimeoutMs(options);
    const run: DjvuRun = { job, tempDir, inputPath, limitMs, deadlineAt: Date.now() + limitMs };
    const pageCount = await readPageCount(run);
    await checkPageSizes(run, pageCount);
    return writePdf(run, drawPlanOf(job, pageCount));
  };

  if (tgt === PDF_TARGET) {
    return withSandboxDir(TEMP_PREFIX, async (tempDir) => {
      const pdfPath = await draw(tempDir);
      const persistedPath = handOffOutput(pdfPath, PDF_TARGET, options, Buffer.isBuffer(input) ? undefined : input);
      return createConversionResult(persistedPath, PDF_TARGET, baseNameOf(job), 'native-djvu', Date.now() - startTime);
    });
  }
  const pdf = await withSandboxDir(TEMP_PREFIX, async (tempDir) => fs.readFileSync(await draw(tempDir)));
  const pageOptions: WorkerEngineOptions = { ...withoutPageSelection(options), maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES };
  return job.convertPdfPages(pdf, tgt, pageOptions, originalFilename);
}
