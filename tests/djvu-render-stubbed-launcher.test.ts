import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  convertDjvu,
  DJVU_CONCURRENT_RUNS,
  DJVULIBRE_DIGESTS_FILE,
  DJVULIBRE_REQUIRED_PATCHES,
  drawBudgetMs,
  MEMORY_LIMIT_MB,
  PDF_PAGE_COUNT_FLOOR_MS,
  PROGRAM_TASK_LIMIT,
  SIZE_RUN_TIMEOUT_MS,
  type DjvuJob,
} from '../src/worker/djvu-render';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/worker/sandbox';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { EngineUnavailableError } from '../src/lib/types';
import { chunk, singlePage } from './helpers/djvu-builder';
import { recordDigests, stampedBinDir } from './helpers/djvulibre-build';
import { withBinaryAt } from './helpers/native-tools';

/**
 * The time limits and the verdicts of the DjVu chain (src/worker/djvu-render.ts), driven with a stand-in for the launcher of
 * sandboxed programs and a clock the stand-in moves, so that the limit each program is given and each way a run can end are
 * reached exactly: a lost launcher helper, a kill from outside and a run cut at a given millisecond cannot be produced by a
 * real program on demand.
 */

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('../src/lib/security/sandbox-launcher', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/security/sandbox-launcher')>()), launchSandboxedBinary: launch }));

const START_MS = 1_000_000;
const LONG_JOB_MS = 600_000;
const SHORT_JOB_MS = 20_000;
const DECLARED_SIDE = 9_999;

interface Sizes {
  readonly width: number;
  readonly height: number;
}

/** What each program does when the chain starts it: the time it takes on the clock, and what it prints or throws. */
interface Programs {
  readonly sizes: readonly Sizes[];
  readonly countMs?: number;
  readonly countError?: Error;
  readonly sizeError?: Error;
  readonly drawMs?: number;
  readonly drawError?: Error;
}

let clock = START_MS;
let root: string;
let dir: string;
beforeEach(() => {
  launch.mockReset();
  clock = START_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-stubbed-'));
  dir = stampedBinDir(root);
  fs.writeFileSync(path.join(dir, 'ddjvu'), 'ddjvu');
  fs.writeFileSync(path.join(dir, 'djvused'), 'djvused');
  recordDigests(dir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The `djvused` script of a run: the value of its `-e` flag. */
const scriptOf = (args: readonly string[]): string | undefined => args[args.indexOf('-e') + 1];

function stubPrograms(programs: Programs): void {
  launch.mockImplementation(async (binary: string, args: string[]) => {
    const script = path.basename(binary) === 'djvused' ? scriptOf(args) : undefined;
    if (script === 'n') {
      clock += programs.countMs ?? 0;
      if (programs.countError) throw programs.countError;
      return { stdout: Buffer.from(`${programs.sizes.length}\n`) };
    }
    if (script === 'size') {
      if (programs.sizeError) throw programs.sizeError;
      return { stdout: Buffer.from(programs.sizes.map(({ width, height }) => `width=${width} height=${height}\n`).join('')) };
    }
    clock += programs.drawMs ?? 0;
    if (programs.drawError) throw programs.drawError;
    fs.writeFileSync(args.at(-1) ?? '', '%PDF-1.4 stand-in');
    return { stdout: Buffer.alloc(0) };
  });
}

/** The page count of the PDF: the pages the stand-in for ddjvu was asked to draw. */
const countPdfPages = vi.fn();
let drawnPages = 0;

function given(programs: Programs, pagesDrawn = programs.sizes.length): void {
  drawnPages = pagesDrawn;
  stubPrograms(programs);
}

/** A page file with a byte for each of `pixels` pixels, far more than the credit a byte can carry needs: the budget credits the pixels whole. */
const inputHolding = (pixels: number): Buffer => singlePage(64, 64, [chunk('JUNK', Buffer.alloc(pixels))]);

async function convert(tgt: string, options: DjvuJob['options'] = {}, input: Buffer = singlePage(64, 64)): Promise<unknown> {
  countPdfPages.mockReset();
  countPdfPages.mockImplementation(async () => drawnPages);
  return convertDjvu({
    input,
    src: 'djvu',
    tgt,
    options,
    originalFilename: 'stubbed.djvu',
    interpreter: path.join(dir, 'ddjvu'),
    convertPdfPages: async () => null,
    countPdfPages,
  });
}

const drawCall = () => launch.mock.calls.find(([binary]) => path.basename(binary as string) === 'ddjvu');
const callOf = (script: string) => launch.mock.calls.find(([binary, args]) => path.basename(binary as string) === 'djvused' && scriptOf(args as string[]) === script);
const limitOf = (call: unknown[] | undefined): number | undefined => (call?.[2] as { timeoutMs?: number } | undefined)?.timeoutMs;
const drawLimitMs = (): number | undefined => limitOf(drawCall());

const refusalOf = async (conversion: Promise<unknown>): Promise<Error> => {
  const outcome = await conversion.then(
    () => null,
    (error: unknown) => error
  );
  if (!(outcome instanceof Error)) throw new Error('the conversion was not refused');
  return outcome;
};

const PAGES: readonly Sizes[] = [
  { width: 3_000, height: 3_000 },
  { width: 2_000, height: 2_000 },
  { width: 64, height: 64 },
];
const pixels = (pages: readonly Sizes[]) => pages.reduce((sum, page) => sum + page.width * page.height, 0);

describe('the budget of ddjvu', () => {
  it.each([
    ['no time spent and one 64 x 64 page in a file as small as a page: the floor and the page at 4 pixels a microsecond', 0, 4_096, 4_096, 15_002],
    ['a hostile file of 8,786 bytes that declares a page of 9,999 x 9,999 pixels: the floor and the 128 pixels a byte its bytes can hold', 0, 9_999 * 9_999, 8_786, 15_282],
    ['8 smooth colour pages of 100 megapixels in 2,168,046 bytes: the floor and 128 pixels a byte, three times the 26.5 s of their drawing four at once on 2.5 CPUs', 0, 8 * 10_000 * 10_000, 2_168_046, 84_378],
    ['reports that took 937 ms and nothing to draw: still the floor', 937, 0, 1_000, 15_000],
    ['reports that took 1,000 ms and nothing to draw: sixteen times the reports', 1_000, 0, 1_000, 16_000],
    ['reports that took 3,000 ms and 13 million pixels a file of a million bytes can hold: sixteen times the reports and the pixels', 3_000, 13_000_000, 1_000_000, 51_250],
  ])('is %s', (_name, reportMs, drawnPixels, inputBytes, expected) => {
    expect(drawBudgetMs(reportMs, drawnPixels, inputBytes)).toBe(expected);
  });

  it('is the floor and the drawn pixels at their rate when the file can hold them: every page for a PDF, the selected ones for images', async () => {
    given({ sizes: PAGES });
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, inputHolding(pixels(PAGES)));
    expect(drawLimitMs()).toBe(drawBudgetMs(0, pixels(PAGES), inputHolding(pixels(PAGES)).length));
    given({ sizes: PAGES }, 1);
    launch.mockClear();
    await convert('png', { timeoutMs: LONG_JOB_MS, pages: '2' }, inputHolding(pixels(PAGES)));
    expect(drawLimitMs()).toBe(drawBudgetMs(0, pixels([PAGES[1]]), inputHolding(pixels(PAGES)).length));
  });

  it('counts no more pixels than the bytes of the file can hold, whatever sizes the pages declare', async () => {
    const declared: Sizes[] = Array.from({ length: 6 }, () => ({ width: DECLARED_SIDE, height: DECLARED_SIDE }));
    const input = singlePage(64, 64);
    given({ sizes: declared });
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, input);
    expect(drawLimitMs()).toBe(drawBudgetMs(0, pixels(declared), input.length));
    expect(drawLimitMs()).toBeLessThan(15_000 + 1_000);
    given({ sizes: PAGES });
    launch.mockClear();
    const scarce = inputHolding(pixels(PAGES) / 256);
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, scarce);
    expect(drawLimitMs()).toBe(drawBudgetMs(0, pixels(PAGES), scarce.length));
    expect(drawLimitMs()).toBeLessThan(drawBudgetMs(0, pixels(PAGES), pixels(PAGES)));
  });

  it('is sixteen times what the work before ddjvu took, when that is more than the floor', async () => {
    const countMs = 3_000;
    given({ sizes: PAGES, countMs });
    const input = inputHolding(pixels(PAGES));
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, input);
    expect(drawLimitMs()).toBe(drawBudgetMs(countMs, pixels(PAGES), input.length));
    expect(drawLimitMs()).toBeGreaterThanOrEqual(16 * countMs);
  });

  it('is what is left of the deadline of the job when that is less', async () => {
    given({ sizes: PAGES, countMs: 3_000 });
    await convert('pdf', { timeoutMs: SHORT_JOB_MS });
    expect(drawLimitMs()).toBe(SHORT_JOB_MS - 3_000);
  });

  it('refuses a document ddjvu did not draw within the budget with the typed time-limit refusal, saying the document took too long to draw', async () => {
    const input = inputHolding(pixels(PAGES));
    const budget = drawBudgetMs(0, pixels(PAGES), input.length);
    given({ sizes: PAGES, drawError: new SandboxedTimeoutError(budget) });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }, input));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', status: 422, message: `The .djvu document took too long to draw: ddjvu ran past the ${budget} ms its pages allow.` });
  });

  it('names the limit of the job, not the slice ddjvu was given, when the deadline cut the drawing', async () => {
    given({ sizes: PAGES, countMs: 3_000, drawError: new SandboxedTimeoutError(SHORT_JOB_MS - 3_000) });
    const error = await refusalOf(convert('pdf', { timeoutMs: SHORT_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', status: 422, message: expect.stringContaining(`${SHORT_JOB_MS} ms`) });
    expect(error.message).not.toContain('took too long to draw');
  });
});

describe('the limits of every program run', () => {
  it('bounds the tasks of each run of djvused and ddjvu', async () => {
    given({ sizes: PAGES });
    await convert('pdf', { timeoutMs: LONG_JOB_MS });
    const limits = launch.mock.calls.map(([binary, args, options]) => {
      const program = path.basename(binary as string);
      return [program, program === 'djvused' ? scriptOf(args as string[]) : 'draw', (options as { rlimits?: { nproc?: number } }).rlimits?.nproc];
    });
    expect(limits).toEqual([
      ['djvused', 'n', PROGRAM_TASK_LIMIT],
      ['djvused', 'size', PROGRAM_TASK_LIMIT],
      ['ddjvu', 'draw', PROGRAM_TASK_LIMIT],
    ]);
  });
});

describe('the DjVu runs of a worker at once', () => {
  const pageCountRuns = () => launch.mock.calls.filter(([binary, args]) => path.basename(binary as string) === 'djvused' && scriptOf(args as string[]) === 'n').length;
  const QUIET_MS = 30;

  /** Holds the first program of every document until the returned release is called. */
  function holdFirstPrograms(): () => void {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const programs = launch.getMockImplementation();
    launch.mockImplementation(async (binary: string, args: string[], options: unknown) => {
      if (path.basename(binary) === 'djvused' && scriptOf(args) === 'n') await held;
      return programs?.(binary, args, options);
    });
    return release;
  }

  it(`runs the programs of ${DJVU_CONCURRENT_RUNS} documents at once and starts the next when one ends`, async () => {
    given({ sizes: PAGES });
    const release = holdFirstPrograms();
    const conversions = Array.from({ length: DJVU_CONCURRENT_RUNS + 1 }, () => convert('pdf', { timeoutMs: LONG_JOB_MS }));
    await vi.waitFor(() => expect(pageCountRuns()).toBe(DJVU_CONCURRENT_RUNS));
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(pageCountRuns()).toBe(DJVU_CONCURRENT_RUNS);
    release();
    await Promise.all(conversions);
    expect(pageCountRuns()).toBe(DJVU_CONCURRENT_RUNS + 1);
  });

  it('refuses a document whose deadline passes while it waits, with the limit of the job, and starts none of its programs', async () => {
    given({ sizes: PAGES });
    const release = holdFirstPrograms();
    const running = Array.from({ length: DJVU_CONCURRENT_RUNS }, () => convert('pdf', { timeoutMs: LONG_JOB_MS }));
    await vi.waitFor(() => expect(pageCountRuns()).toBe(DJVU_CONCURRENT_RUNS));
    const error = await refusalOf(convert('pdf', { timeoutMs: QUIET_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', message: expect.stringContaining(`${QUIET_MS} ms`) });
    expect(pageCountRuns()).toBe(DJVU_CONCURRENT_RUNS);
    release();
    await Promise.all(running);
  });

  it('stops waiting when the job is cancelled', async () => {
    given({ sizes: PAGES });
    const release = holdFirstPrograms();
    const running = Array.from({ length: DJVU_CONCURRENT_RUNS }, () => convert('pdf', { timeoutMs: LONG_JOB_MS }));
    await vi.waitFor(() => expect(pageCountRuns()).toBe(DJVU_CONCURRENT_RUNS));
    const cancel = new AbortController();
    const waiting = refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS, signal: cancel.signal }));
    cancel.abort(new Error('the job was cancelled'));
    expect(await waiting).toMatchObject({ message: 'the job was cancelled' });
    release();
    await Promise.all(running);
    expect(pageCountRuns()).toBe(DJVU_CONCURRENT_RUNS);
  });
});

describe('the djvulibre build that is run', () => {
  const patchesDir = () => path.join(root, 'share', 'doc', 'djvulibre', 'patches');

  it.each(DJVULIBRE_REQUIRED_PATCHES)('refuses a ddjvu whose build lacks %s as an unavailable engine, before any program starts', async (patch) => {
    fs.rmSync(path.join(patchesDir(), patch));
    given({ sizes: PAGES });
    const error = await refusalOf(convert('pdf'));
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(error).toMatchObject({ engineName: 'ddjvu' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['ddjvu', 'djvused'])('refuses a build whose %s is not the program it recorded, before any program starts', async (program) => {
    fs.writeFileSync(path.join(dir, program), `${program} changed after the build`);
    given({ sizes: PAGES });
    const error = await refusalOf(convert('pdf'));
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(error.message).toContain(`is not the ${program} its build recorded in ${DJVULIBRE_DIGESTS_FILE}`);
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a build without the digests of its programs', async () => {
    fs.rmSync(path.join(root, 'share', 'doc', 'djvulibre', DJVULIBRE_DIGESTS_FILE));
    given({ sizes: PAGES });
    expect(await refusalOf(convert('pdf'))).toBeInstanceOf(EngineUnavailableError);
    expect(launch).not.toHaveBeenCalled();
  });

  it('checks the programs again once one is replaced after a run it allowed', async () => {
    given({ sizes: PAGES });
    await convert('pdf', { timeoutMs: LONG_JOB_MS });
    const replacement = path.join(dir, 'ddjvu.new');
    fs.writeFileSync(replacement, 'another ddjvu');
    fs.renameSync(replacement, path.join(dir, 'ddjvu'));
    launch.mockClear();
    expect(await refusalOf(convert('pdf'))).toBeInstanceOf(EngineUnavailableError);
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a ddjvu that is a link to nothing as an unavailable engine, not as a crash of the conversion', async () => {
    fs.rmSync(path.join(dir, 'ddjvu'));
    fs.symlinkSync(path.join(root, 'nowhere', 'ddjvu'), path.join(dir, 'ddjvu'));
    given({ sizes: PAGES });
    const error = await refusalOf(convert('pdf'));
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(error).toMatchObject({ engineName: 'ddjvu' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('takes DDJVU_PATH only to the patched build', async () => {
    fs.rmSync(patchesDir(), { recursive: true });
    given({ sizes: PAGES });
    const error = await withBinaryAt('DDJVU_PATH', path.join(dir, 'ddjvu'), () => refusalOf(dispatchConversion(singlePage(64, 64), 'djvu', 'pdf', {}, 'a.djvu')));
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('the page count of the PDF', () => {
  it('is not started with less than its floor of the deadline left: the deadline answers, with the limit of the job', async () => {
    given({ sizes: [PAGES[2]], drawMs: SHORT_JOB_MS - PDF_PAGE_COUNT_FLOOR_MS + 500 });
    const error = await refusalOf(convert('pdf', { timeoutMs: SHORT_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', message: expect.stringContaining(`${SHORT_JOB_MS} ms`) });
    expect(countPdfPages).not.toHaveBeenCalled();
  });

  it('is started with its floor or more left', async () => {
    given({ sizes: [PAGES[2]], drawMs: SHORT_JOB_MS - PDF_PAGE_COUNT_FLOOR_MS });
    await convert('pdf', { timeoutMs: SHORT_JOB_MS });
    expect(countPdfPages).toHaveBeenCalledOnce();
  });
});

describe('how a size run ended', () => {
  const spawnFailure = Object.assign(new SandboxedProcessError('spawn djvused ENOENT', 127, ''), { spawnErrorCode: 'ENOENT' });

  it.each([
    ['ended with no status and no signal, as a lost launcher helper ends it', new SandboxedProcessError('Sandboxed execution error: the launcher exited', null, 'the launcher exited')],
    ['was stopped by SIGTERM', new SandboxedProcessError('Process terminated by signal SIGTERM', null, '', 'SIGTERM')],
    ['was stopped by SIGHUP', new SandboxedProcessError('Process terminated by signal SIGHUP', null, '', 'SIGHUP')],
    ['was killed by the out-of-memory killer (SIGKILL under the memory limit)', new SandboxedMemoryLimitError(MEMORY_LIMIT_MB, 'SIGKILL')],
    ['was stopped by the resident-size watch', new SandboxedMemoryLimitError(MEMORY_LIMIT_MB)],
    ['did not start', spawnFailure],
    ['could not be executed under the wrapper (status 126)', new SandboxedProcessError('Process exited with code 126', 126, 'exec: Permission denied')],
    ['was not found by the wrapper (status 127)', new SandboxedProcessError('Process exited with code 127', 127, 'exec: not found')],
    ['printed more than its output limit', new SandboxedBufferLimitError(16 * 1024 * 1024)],
  ])('is not a verdict on the document when the run %s', async (_name, sizeError) => {
    given({ sizes: [PAGES[2]], sizeError });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error.name).not.toBe('DjvuIncludeStructureError');
    expect(error.message).not.toContain('include structure');
    expect(error.message).not.toContain('crashed');
    expect(drawCall()).toBeUndefined();
  });

  it.each([
    ['faulted under the address space limit (SIGSEGV)', new SandboxedMemoryLimitError(MEMORY_LIMIT_MB, 'SIGSEGV'), `djvused crashed (SIGSEGV) under its ${MEMORY_LIMIT_MB} MB memory limit while opening the pages of the DjVu document.`],
    ['aborted under the address space limit (SIGABRT)', new SandboxedMemoryLimitError(MEMORY_LIMIT_MB, 'SIGABRT'), `djvused crashed (SIGABRT) under its ${MEMORY_LIMIT_MB} MB memory limit while opening the pages of the DjVu document.`],
    ['faulted without a memory limit (SIGSEGV)', new SandboxedProcessError('Process terminated by signal SIGSEGV', null, '', 'SIGSEGV'), 'djvused crashed (SIGSEGV) while opening the pages of the DjVu document.'],
    ['raised a floating point exception (SIGFPE)', new SandboxedProcessError('Process terminated by signal SIGFPE', null, '', 'SIGFPE'), 'djvused crashed (SIGFPE) while opening the pages of the DjVu document.'],
    ['hit an illegal instruction (SIGILL)', new SandboxedProcessError('Process terminated by signal SIGILL', null, '', 'SIGILL'), 'djvused crashed (SIGILL) while opening the pages of the DjVu document.'],
  ])('refuses a document on which the program %s, saying it crashed and not what the cause was', async (_name, sizeError, message) => {
    given({ sizes: [PAGES[2]], sizeError });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error).toMatchObject({ name: 'DjvuIncludeStructureError', status: 422, message });
    expect(error.message).not.toContain('too deep');
    expect(drawCall()).toBeUndefined();
  });

  it('refuses a document on which the program exited with a status other than zero, naming what it printed', async () => {
    given({ sizes: [PAGES[2]], sizeError: new SandboxedProcessError('*** Unexpected End Of File.', 10, '*** Unexpected End Of File.') });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error).toMatchObject({ name: 'DjvuIncludeStructureError', status: 422, message: expect.stringContaining('djvused could not open the pages of the DjVu document (exit status 10): *** Unexpected End Of File.') });
    expect(drawCall()).toBeUndefined();
  });

  it.each([
    ['the size run', { sizeError: new SandboxedTimeoutError(SIZE_RUN_TIMEOUT_MS) }, 'size', SIZE_RUN_TIMEOUT_MS],
    ['the page count run', { countError: new SandboxedTimeoutError(30_000) }, 'n', 30_000],
  ])('hands %s past its own limit on as a time-out, not as a verdict on the document', async (_name, failure, script, ownLimitMs) => {
    given({ sizes: [PAGES[2]], ...failure });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error).toMatchObject({ name: 'SandboxedTimeoutError', timeoutMs: ownLimitMs });
    expect(limitOf(callOf(script))).toBe(ownLimitMs);
    expect(drawCall()).toBeUndefined();
  });

  it('names the limit of the job when the deadline cut the size run', async () => {
    given({ sizes: [PAGES[2]], sizeError: new SandboxedTimeoutError(SHORT_JOB_MS) });
    const error = await refusalOf(convert('pdf', { timeoutMs: SHORT_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', message: expect.stringContaining(`${SHORT_JOB_MS} ms`) });
  });
});
