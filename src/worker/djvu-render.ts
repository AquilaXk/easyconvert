import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkDjvuContainer } from '../lib/conversions/djvu-container';
import { DJVUSED_MAX_OUTPUT_BYTES, DJVUSED_PAGE_COUNT_SCRIPT, DJVUSED_SIZE_SCRIPT, parseDjvusedPageCount, parseDjvusedSizes, type DjvuPageSize } from '../lib/conversions/djvu-report';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { groupConsecutiveRanges, OFFICE_PAGE_IMAGE_MAX_PAGES, resolvePageSelection } from '../lib/conversions/page-range';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { Semaphore } from '../lib/workers/semaphore';
import { ConversionFailedError, CpuTaskTimeoutError, EngineUnavailableError, InvalidPageRangeError } from '../lib/types';
import { boundRenderedPages } from './poppler-ppm';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError, type SandboxedExecutionResult } from './sandbox';
import { createConversionResult, drawnPdfTooLargeError, handOffOutput, MAX_DRAWN_PDF_BYTES_FOR_IMAGES, readRawInputBuffer, withSandboxDir } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions } from './worker-types';
import type { XpsJob } from './xps-render';

/**
 * DjVu documents are drawn by `ddjvu` of djvulibre (GPL-2.0-or-later, a separate program built from the Debian source of 3.5.28 with
 * two patches to libdjvu, scripts/install-djvulibre.sh) into a PDF, which the native PDF tools take to every page target, as
 * GhostXPS's PDF is taken. Only that build is run (`DJVULIBRE_REQUIRED_PATCHES`, `DJVULIBRE_DIGESTS_FILE`).
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
 * document whose includes form a cycle or run thousands of files deep (a stack overflow, signal 11). What the program raises
 * there (a crash signal or a status other than zero) refuses the document as one whose include structure it cannot open, so
 * djvulibre itself judges the include graph, in the sandbox, and the worker holds no model of it; a run that something else
 * ended (the deadline, a time-out, a kill, a lost helper) is not a verdict on the document. All three programs run before the output exists,
 * in a directory of their own that holds the one file and the output, in the sandbox, without network, and share the one
 * deadline of the job (`DjvuRun`): a document costs at most the stage limit, 120 s by default, whatever its includes. `ddjvu`
 * also has a budget of its own, from what the reports took and the pixels it draws, at most as many as its bytes can hold
 * (`drawBudgetMs`), and every program a limit on the threads of its run (`PROGRAM_TASK_LIMIT`). A worker runs the programs of at most
 * `DJVU_CONCURRENT_RUNS` documents at once; another document waits for one of them for at most `DJVU_SLOT_WAIT_MS` and then is
 * refused as busy, so that a few files that hold the slots for their whole deadline cost the documents behind them seconds and not their deadlines.
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
export const MEMORY_LIMIT_MB = 2048;
/**
 * The size limit of one file the program writes. It writes two: the temporary TIFF of every page, which `tiff2pdf` then turns
 * into the PDF, and the PDF, each under this limit. The TIFF of a colour page is about as large as the page's PDF image, so
 * the limit is met by the pages together: see entry 134 of docs/policy-decisions.md for what it allows.
 */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
/** The page count of the drawn PDF, the limit of the other page chains, held to the deadline of the job. */
const PDF_PAGE_COUNT_TIMEOUT_MS = 45_000;
/** Less than this left of the deadline after `ddjvu` and the PDF is not counted: the deadline answers instead. */
export const PDF_PAGE_COUNT_FLOOR_MS = 2_000;
/**
 * The `n` run. It reads the directory alone: 0.2 s for 3,000 pages with 3.5.28 on the 4 vCPU Linux arm64 test VM, and 4.3 s
 * for `n;ls` on the largest directory taken (10,000 pages and 10,000 shared files); the limit is six times that.
 */
const PAGE_COUNT_RUN_TIMEOUT_MS = 30_000;
/**
 * The `size` run, which decodes the first wavelet chunk of a `FORM:PM44` or `FORM:BM44` page: 40 ms a page of 2550 x 3300 scanned
 * text on the test VM, so 40 s for a book of 1,000 such pages (119 s for 3,000). The limit is three times the 1,000-page book; a
 * run past it is a time-out, not a verdict on the document (entry 134 of docs/policy-decisions.md). Under the default stage limit
 * the deadline comes first.
 */
export const SIZE_RUN_TIMEOUT_MS = 120_000;
/**
 * The budget of `ddjvu`: `max(15 s, 16 x the time the two reports took) + the credited pixels at 4 megapixels a second`, at most what
 * is left of the deadline. The pixels are the drawn pages' as the file declares them, but no more than `DRAW_PIXELS_PER_INPUT_BYTE` for
 * each byte of the file: a file declares any size for a few bytes, and the program draws a blank page declared 9,999 x 9,999 in 0.46 s,
 * so without the cap 260 such pages in a file of 9 KB would hold the worker until the deadline. The cap keeps three times its drawing,
 * when four drawings share the 2.5 CPUs of a worker, for the measured document that needs the most time for its bytes: 8 smooth colour
 * pages of 100 megapixels (369 pixels a byte, drawn in 24.7 to 26.5 s four at once) get 84.4 s from 15 s and 128 pixels a byte. The
 * documents with more pixels a byte draw within the floor (bilevel pages, 4,700 a byte, in 0.4 s). A file buys 32 microseconds of
 * drawing for each of its bytes (entry 135 of docs/policy-decisions.md has the measured documents and chains).
 */
const DRAW_BUDGET_FLOOR_MS = 15_000;
const DRAW_BUDGET_REPORT_FACTOR = 16;
const DRAW_PIXELS_PER_MS = 4_000;
const DRAW_PIXELS_PER_INPUT_BYTE = 128;
/**
 * The tasks of one run of a program, set as RLIMIT_NPROC in the user namespace of the run (process-sandbox.ts). The program decodes each
 * file a page includes on a thread of its own and keeps the threads of a chain alive until its end; the real documents use at most 3
 * at once. At this limit the patched `ddjvu` fails a chain of 300 shared files in 0.08 s with at most 64 threads instead of taking up
 * to 252 of the 256 tasks of the worker container, and draws a chain of 40 (entry 135).
 */
export const PROGRAM_TASK_LIMIT = 64;
/**
 * The documents whose programs a worker runs at once, each run at most `PROGRAM_TASK_LIMIT` tasks: 128 tasks, half the `pids_limit` of
 * 256 of every worker container, whatever its `WORKER_CONCURRENCY` (4 at the launch, 6 in the light worker of the split profile). A chain
 * whose files carry data keeps its threads until each file is decoded, so the bound holds for as long as that takes (entry 135).
 */
export const DJVU_CONCURRENT_RUNS = 2;
/**
 * How long a document waits for a slot of the worker before it is refused as busy (a 503 the job retries, on another worker when the
 * pool has one). A document can hold a slot for its whole deadline, 120 s: two files of about 3.3 MB do (entry 135), and a waiter would
 * then spend its own deadline queued, holding a job slot of the worker, to fail as if its conversion had been slow. At 20 s a waiter
 * costs a job slot for a sixth of a deadline; a waiter behind two of the slowest measured documents (26.5 s, entry 135) is refused and retried.
 */
export const DJVU_SLOT_WAIT_MS = 20_000;
/**
 * The slots of the runs of this worker. A document waits for one for `DJVU_SLOT_WAIT_MS`; the jobs of the worker bound how many wait,
 * so the queue has no limit of its own.
 */
const djvuRunSlots = new Semaphore(DJVU_CONCURRENT_RUNS);
/**
 * The patches of the djvulibre build of scripts/install-djvulibre.sh that the limits of this file rely on: a shared file searched once
 * (else a chain of shared files holds `ddjvu` for a time that grows with its paths) and a decode that fails when its thread cannot start
 * (else `ddjvu` waits forever at the task limit). The build installs them beside its programs, in <prefix>/share/doc/djvulibre/patches.
 */
export const DJVULIBRE_REQUIRED_PATCHES = ['include-search-visit-once.patch', 'decode-thread-start-failure.patch'] as const;
/**
 * The SHA-256 of `ddjvu` and `djvused` as the build installed them, in the lines of `sha256sum` beside the patches. With the patches it is
 * the stamp this file checks for each document, on the real files of both programs: any other `ddjvu`, such as the distribution's, and a
 * program changed after the build are not run, wherever they are found or `DDJVU_PATH` points.
 */
export const DJVULIBRE_DIGESTS_FILE = 'programs.sha256';
const DIGEST_LINE = /^([0-9a-f]{64}) {2}(\S+)$/;
/**
 * Four glibc heaps for the program's threads. Without a bound each thread that decodes an included file gets an arena of its own, 64 MiB
 * of address space each, and from about 30 of them the 2 GiB limit is met: the patched program then fails a chain of 40 shared files
 * that it draws with a bound. Four arenas reserve at most 256 MiB beside the stacks of the 64 tasks of a run, and give each of the at
 * most three decoding threads of a real document a heap of its own, where one heap made them share it (entry 135).
 */
const DRAW_ENVIRONMENT: Readonly<Record<string, string>> = { MALLOC_ARENA_MAX: '4' };
/** What the report of a document of a few hundred pages comes to; the launcher helper copies it back. */
const REPORT_EXPECTED_OUTPUT_BYTES = 64 * 1024;
const REPORT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
/** The program writes its result to a file in the job directory and prints nothing the worker has to copy. */
const NO_PIPED_OUTPUT_BYTES = 0;
/** The signals of a program that failed by itself; a SIGKILL or SIGTERM comes from outside it. */
const CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set(['SIGSEGV', 'SIGBUS', 'SIGABRT', 'SIGFPE', 'SIGILL']);
/** The statuses of a shell that could not run the program (126 found but not executable, 127 not found): not what the program said of the file. */
const NOT_STARTED_STATUSES: ReadonlySet<number> = new Set([126, 127]);
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

/** The two programs of a run, as found next to each other. */
interface DjvulibrePrograms {
  readonly render: string;
  readonly report: string;
}

/**
 * The drawing of one document: the programs, the file in its job directory, its size, and the one deadline that the wait for a slot, the
 * `djvused` runs, `ddjvu` and the page count of its PDF share, each given what is left of it (at most its own limit). The deadline is
 * `limitMs` after `startedAt`.
 */
interface DjvuRun {
  readonly job: DjvuJob;
  readonly programs: DjvulibrePrograms;
  readonly tempDir: string;
  readonly inputPath: string;
  readonly inputBytes: number;
  readonly limitMs: number;
  readonly startedAt: number;
}

/** How long a program may run: what is left of the deadline, or its own limit when that comes first. */
interface TimeSlice {
  readonly timeoutMs: number;
  readonly cutByDeadline: boolean;
}

/** A document whose pages `djvused` cannot open: the program crashed or failed creating the files they include. */
class DjvuIncludeStructureError extends ConversionFailedError {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'DjvuIncludeStructureError';
  }
}

/** A document that `ddjvu` did not draw within its budget: the typed time-limit refusal, with what ran out. */
class DjvuDrawTimeoutError extends CpuTaskTimeoutError {
  constructor(src: string, budgetMs: number) {
    super(`.${src} drawing`, budgetMs, `The .${src} document took too long to draw: ddjvu ran past the ${budgetMs} ms its pages allow.`);
  }
}

/** The pages the program draws, their pixels, and the limit on the PDF it writes. */
interface DrawPlan {
  /** The `-page` argument, or undefined for every page. */
  readonly pageSpec: string | undefined;
  readonly pageCount: number;
  readonly drawnPixels: number;
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

/** The job ran out of its deadline: reported with the limit of the job, not with the slice the last program was given. */
function deadlineExceeded(run: DjvuRun): CpuTaskTimeoutError {
  return new CpuTaskTimeoutError(`.${run.job.src} to .${run.job.tgt} conversion`, run.limitMs);
}

/** What is left of the deadline of the run, at most `ownLimitMs`; a run that has used all of its time starts nothing more. */
function sliceOf(run: DjvuRun, ownLimitMs: number): TimeSlice {
  const remaining = run.startedAt + run.limitMs - Date.now();
  if (remaining <= 0) throw deadlineExceeded(run);
  return remaining < ownLimitMs ? { timeoutMs: remaining, cutByDeadline: true } : { timeoutMs: ownLimitMs, cutByDeadline: false };
}

/**
 * Runs `program` in the sandbox within `ownLimitMs` and the deadline. A run the deadline cut short is the deadline's error; a
 * run past its own limit throws SandboxedTimeoutError for the caller to name.
 */
async function launchInRun(
  run: DjvuRun,
  ownLimitMs: number,
  program: string,
  args: string[],
  limits: Pick<LaunchedExecutionOptions, 'maxBuffer' | 'maxFileSize' | 'expectedOutputBytes' | 'env'>
): Promise<SandboxedExecutionResult> {
  const slice = sliceOf(run, ownLimitMs);
  const options: LaunchedExecutionOptions = {
    memoryLimitMb: MEMORY_LIMIT_MB,
    rlimits: { nproc: PROGRAM_TASK_LIMIT },
    networkIsolated: true,
    signal: run.job.options.signal,
    cwd: run.tempDir,
    timeoutMs: slice.timeoutMs,
    ...limits,
  };
  try {
    return await launchSandboxedBinary(program, args, options);
  } catch (err) {
    if (err instanceof SandboxedTimeoutError && slice.cutByDeadline) throw deadlineExceeded(run);
    throw err;
  }
}

/** Reads the file in chunks, so that hashing a program does not hold the worker's event loop. */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const fileExists = (file: string): Promise<boolean> => fs.promises.access(file).then(() => true, () => false);

/** The SHA-256 of each program as the build recorded it, from the lines of `sha256sum` in the digests file. */
async function recordedDigests(digestsFile: string): Promise<Map<string, string>> {
  const recorded = new Map<string, string>();
  for (const line of (await fs.promises.readFile(digestsFile, 'utf-8')).split('\n')) {
    const match = DIGEST_LINE.exec(line);
    if (match) recorded.set(match[2], match[1]);
  }
  return recorded;
}

/** An error of the file system (a missing file, a link to nothing, no permission): the build cannot be read, which is not a fault of the worker. */
function isFileSystemError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * Why `ddjvu` and `djvused` are not the build of scripts/install-djvulibre.sh, or undefined when they are: the required patches and the
 * digests of both programs sit in the doc directory of the prefix of the real `ddjvu`. The programs are hashed for each document, a few
 * milliseconds against the three sandboxed runs of a document, so that a program replaced after the build is never run. The reason
 * names no path, as it reaches the client; the paths go to the log.
 */
async function buildProblemOf(ddjvu: string, djvused: string): Promise<string | undefined> {
  try {
    const programs = { [RENDER_PROGRAM]: await fs.promises.realpath(ddjvu), [REPORT_PROGRAM]: await fs.promises.realpath(djvused) };
    const docDir = path.join(path.dirname(programs[RENDER_PROGRAM]), '..', 'share', 'doc', 'djvulibre');
    for (const name of DJVULIBRE_REQUIRED_PATCHES) {
      if (!(await fileExists(path.join(docDir, 'patches', name)))) return `its build has no ${name}`;
    }
    const recorded = await recordedDigests(path.join(docDir, DJVULIBRE_DIGESTS_FILE));
    for (const [name, file] of Object.entries(programs)) {
      if (recorded.get(name) !== (await sha256Of(file))) {
        console.warn(`[djvu] ${file} is not the ${name} recorded in ${DJVULIBRE_DIGESTS_FILE} beside ${docDir}`);
        return `the ${name} program differs from the one its build recorded in ${DJVULIBRE_DIGESTS_FILE}`;
      }
    }
    return undefined;
  } catch (err) {
    if (!isFileSystemError(err)) throw err;
    console.warn(`[djvu] the build of ${ddjvu} cannot be read: ${err.message}`);
    return `its build files cannot be read (${err.code})`;
  }
}

/** Whether `ddjvu` and the `djvused` next to it are the build of scripts/install-djvulibre.sh. */
export async function isPatchedDjvulibre(ddjvu: string): Promise<boolean> {
  return (await buildProblemOf(ddjvu, path.join(path.dirname(ddjvu), REPORT_PROGRAM))) === undefined;
}

/** `ddjvu` and the `djvused` that ships with it next to it. */
function programsOf(job: DjvuJob): DjvulibrePrograms {
  const report = path.join(path.dirname(job.interpreter), REPORT_PROGRAM);
  if (!fs.existsSync(report)) throw new EngineUnavailableError(REPORT_PROGRAM, `${REPORT_PROGRAM} (djvulibre) is not installed next to ${RENDER_PROGRAM}`);
  return { render: job.interpreter, report };
}

/** Refuses programs that are not the patched build, whose patches the limits of a run rely on, wherever they were found or `DDJVU_PATH` points. */
async function requirePatchedBuild(programs: DjvulibrePrograms): Promise<void> {
  const problem = await buildProblemOf(programs.render, programs.report);
  if (problem !== undefined) {
    throw new EngineUnavailableError(RENDER_PROGRAM, `${RENDER_PROGRAM} is not the djvulibre build of scripts/install-djvulibre.sh, whose patches the limits of a DjVu run rely on: ${problem}`);
  }
}

/** What `script` of `djvused` prints for the document, in the sandbox. */
async function runReport(run: DjvuRun, script: string, ownLimitMs: number): Promise<string> {
  const report = await launchInRun(run, ownLimitMs, run.programs.report, ['-e', script, run.inputPath], {
    maxBuffer: DJVUSED_MAX_OUTPUT_BYTES,
    maxFileSize: REPORT_MAX_FILE_BYTES,
    expectedOutputBytes: REPORT_EXPECTED_OUTPUT_BYTES,
  });
  return report.stdout.toString('utf-8');
}

/** The page count `djvused -e n` reports, under the page limit. */
async function readPageCount(run: DjvuRun): Promise<number> {
  try {
    return parseDjvusedPageCount(await runReport(run, DJVUSED_PAGE_COUNT_SCRIPT, PAGE_COUNT_RUN_TIMEOUT_MS));
  } catch (err) {
    throw toRendererError(err, REPORT_PROGRAM, run.job.src, run.tempDir);
  }
}

/**
 * The refusal for a `size` run that did not open the pages, or undefined when the run did not end by the document. Only what the
 * program raises is a verdict: a status other than zero, or a crash signal, which the sandbox reports as the memory limit when it
 * is a segmentation fault under the address space limit (process-sandbox.ts), as the stack overflow of a deep or cyclic include
 * graph arrives. A timeout, a kill, a run ended with no status and no signal (a lost launcher helper), a program that did not start
 * (status 126 or 127 under the wrapper, which does not pass `spawnErrorCode` on) and an output over its limit are not the document's.
 */
function failedSizeRun(err: unknown, tempDir: string): DjvuIncludeStructureError | undefined {
  if (err instanceof SandboxedMemoryLimitError) {
    return err.signal !== undefined && CRASH_SIGNALS.has(err.signal) ? crashedWhileOpening(err.signal, err.limitMb) : undefined;
  }
  if (!(err instanceof SandboxedProcessError) || err.spawnErrorCode !== undefined) return undefined;
  if (err.signal !== null) return CRASH_SIGNALS.has(err.signal) ? crashedWhileOpening(err.signal) : undefined;
  if (err.exitCode === null || err.exitCode === 0 || NOT_STARTED_STATUSES.has(err.exitCode)) return undefined;
  const detail = stderrDetail(err.stderr, tempDir);
  return new DjvuIncludeStructureError(`djvused could not open the pages of the DjVu document (exit status ${err.exitCode})${detail ? `: ${detail}` : ''}.`);
}

function crashedWhileOpening(signal: NodeJS.Signals, memoryLimitMb?: number): DjvuIncludeStructureError {
  const limit = memoryLimitMb === undefined ? '' : ` under its ${memoryLimitMb} MB memory limit`;
  return new DjvuIncludeStructureError(`djvused crashed (${signal})${limit} while opening the pages of the DjVu document.`);
}

/**
 * The size of every page, checked against the pixel limit: `ddjvu` draws each page at its own size. The run opens the pages and
 * the files they include, so its failure refuses the document before `ddjvu` starts on it. Every page is checked, also for a
 * selection: the include structure of any page is the document's.
 */
async function readPageSizes(run: DjvuRun, pageCount: number): Promise<DjvuPageSize[]> {
  try {
    return parseDjvusedSizes(await runReport(run, DJVUSED_SIZE_SCRIPT, SIZE_RUN_TIMEOUT_MS), pageCount);
  } catch (err) {
    throw failedSizeRun(err, run.tempDir) ?? toRendererError(err, REPORT_PROGRAM, run.job.src, run.tempDir);
  }
}

/**
 * The budget of `ddjvu` for a document of `inputBytes` whose reports took `reportMs` and whose drawn pages declare `drawnPixels`:
 * the pixels count only up to what the bytes of the file can hold.
 */
export function drawBudgetMs(reportMs: number, drawnPixels: number, inputBytes: number): number {
  const creditedPixels = Math.min(drawnPixels, inputBytes * DRAW_PIXELS_PER_INPUT_BYTE);
  return Math.ceil(Math.max(DRAW_BUDGET_FLOOR_MS, DRAW_BUDGET_REPORT_FACTOR * reportMs) + creditedPixels / DRAW_PIXELS_PER_MS);
}

/** The pages as the `-page` argument of the program: `3-5,8`. */
function pageSpecOf(pages: readonly number[]): string {
  return groupConsecutiveRanges([...pages]).map(({ start, end }) => (start === end ? String(start) : `${start}-${end}`)).join(',');
}

/** The request without its page selection, for the PDF of only the selected pages. */
function withoutPageSelection(options: WorkerEngineOptions): WorkerEngineOptions {
  return { ...options, page: undefined, pages: undefined };
}

function pixelsOf(sizes: readonly DjvuPageSize[], pages: readonly number[]): number {
  return pages.reduce((sum, page) => sum + sizes[page - 1].width * sizes[page - 1].height, 0);
}

/**
 * What to draw. A PDF target is every page. A page target is the pages the request selects, at most as many as the other page
 * chains render in one request (the whole document when none is selected), so that a long document is not drawn for one page.
 */
function drawPlanOf(job: DjvuJob, sizes: readonly DjvuPageSize[]): DrawPlan {
  const pageCount = sizes.length;
  const every = Array.from({ length: pageCount }, (_, index) => index + 1);
  if (job.tgt === PDF_TARGET) return { pageSpec: undefined, pageCount, drawnPixels: pixelsOf(sizes, every), maxBytes: MAX_OUTPUT_BYTES };
  const selected = resolvePageSelection(job.options.page, job.options.pages, pageCount, (page, count) => new InvalidPageRangeError(`Page number ${page} is out of bounds (1-${count})`)) ?? every;
  const drawn = boundRenderedPages(selected, { ...job.options, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES });
  return {
    pageSpec: drawn.length === pageCount ? undefined : pageSpecOf(drawn),
    pageCount: drawn.length,
    drawnPixels: pixelsOf(sizes, drawn),
    maxBytes: MAX_DRAWN_PDF_BYTES_FOR_IMAGES,
  };
}

async function drawWithinBudget(run: DjvuRun, plan: DrawPlan, budgetMs: number, pdfPath: string): Promise<void> {
  const { job, tempDir, inputPath } = run;
  const pageArguments = plan.pageSpec === undefined ? [] : [`-page=${plan.pageSpec}`];
  try {
    await launchInRun(run, budgetMs, run.programs.render, [FORMAT_FLAG, ...pageArguments, inputPath, pdfPath], {
      maxBuffer: job.options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
      maxFileSize: MAX_OUTPUT_BYTES,
      expectedOutputBytes: NO_PIPED_OUTPUT_BYTES,
      env: DRAW_ENVIRONMENT,
    });
  } catch (err) {
    if (err instanceof SandboxedTimeoutError) throw new DjvuDrawTimeoutError(job.src, budgetMs);
    throw toRendererError(err, RENDER_PROGRAM, job.src, tempDir);
  }
}

/** Draws the PDF in the slot of the run, from the reports that preceded it. */
async function drawPdf(run: DjvuRun, plan: DrawPlan, reportMs: number): Promise<string> {
  const pdfPath = path.join(run.tempDir, PDF_FILE);
  await drawWithinBudget(run, plan, drawBudgetMs(reportMs, plan.drawnPixels, run.inputBytes), pdfPath);
  return pdfPath;
}

/** The checks of the drawn PDF, which are not DjVu programs and so hold no slot: its size, and the pages the PDF tools count in it. */
async function checkDrawnPdf(run: DjvuRun, plan: DrawPlan, pdfPath: string): Promise<void> {
  const { job } = run;
  const size = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
  if (size === 0) throw new ConversionFailedError(`ddjvu drew no page from the .${job.src} file.`);
  if (size > plan.maxBytes) throw drawnPdfTooLargeError('ddjvu', job.src, size, plan.maxBytes);
  const countSlice = sliceOf(run, PDF_PAGE_COUNT_TIMEOUT_MS);
  if (countSlice.timeoutMs < PDF_PAGE_COUNT_FLOOR_MS) throw deadlineExceeded(run);
  const drawn = await job.countPdfPages(pdfPath, run.tempDir, countSlice.timeoutMs, job.options.signal);
  if (drawn !== plan.pageCount) {
    throw new ConversionFailedError(`ddjvu drew ${drawn} of the ${plan.pageCount} pages that the .${job.src} file lists.`);
  }
}

/** The refusal of a worker whose slots stayed taken for the whole wait: unavailable for now, so the job is retried. */
function busyError(): EngineUnavailableError {
  return new EngineUnavailableError(RENDER_PROGRAM, `all ${DJVU_CONCURRENT_RUNS} DjVu runs of this worker stayed busy for ${DJVU_SLOT_WAIT_MS / 1000} s; try again shortly`);
}

/**
 * Runs `task` in a slot of the worker. The wait is cut at `DJVU_SLOT_WAIT_MS` (the busy refusal) or at the deadline of the run when
 * that is shorter (the deadline's error), and by the signal of the job.
 */
async function inRunSlot<T>(run: DjvuRun, task: () => Promise<T>): Promise<T> {
  const waitMs = Math.min(DJVU_SLOT_WAIT_MS, run.limitMs);
  const waitBound = AbortSignal.timeout(waitMs);
  const { signal } = run.job.options;
  try {
    return await djvuRunSlots.run(task, signal ? AbortSignal.any([waitBound, signal]) : waitBound);
  } catch (err) {
    if (waitBound.aborted && err === waitBound.reason) throw waitMs < run.limitMs ? busyError() : deadlineExceeded(run);
    throw err;
  }
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
    const programs = programsOf(job);
    const inputPath = path.join(tempDir, INPUT_FILE);
    fs.writeFileSync(inputPath, bytes, { mode: 0o600 });
    const run: DjvuRun = { job, programs, tempDir, inputPath, inputBytes: bytes.length, limitMs: runTimeoutMs(options), startedAt: Date.now() };
    const { plan, pdfPath } = await inRunSlot(run, async () => {
      await requirePatchedBuild(programs);
      const reportsStartedAt = Date.now();
      const pageCount = await readPageCount(run);
      const plan = drawPlanOf(job, await readPageSizes(run, pageCount));
      return { plan, pdfPath: await drawPdf(run, plan, Date.now() - reportsStartedAt) };
    });
    await checkDrawnPdf(run, plan, pdfPath);
    return pdfPath;
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
