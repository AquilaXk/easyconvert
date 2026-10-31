import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  convertDjvu,
  DRAW_BUDGET_FLOOR_MS,
  DRAW_BUDGET_REPORT_FACTOR,
  DRAW_PIXELS_PER_INPUT_BYTE,
  DRAW_PIXELS_PER_MS,
  MEMORY_LIMIT_MB,
  PDF_PAGE_COUNT_FLOOR_MS,
  SIZE_RUN_TIMEOUT_MS,
  type DjvuJob,
} from '../src/worker/djvu-render';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/worker/sandbox';
import { chunk, singlePage } from './helpers/djvu-builder';

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
let dir: string;
beforeEach(() => {
  launch.mockReset();
  clock = START_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-stubbed-'));
  fs.writeFileSync(path.join(dir, 'djvused'), '');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
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

/** A page file that holds `pixels` pixels at the most credit a byte can carry: the size of the file is what the budget counts. */
const inputHolding = (pixels: number): Buffer => singlePage(64, 64, [chunk('JUNK', Buffer.alloc(Math.ceil(pixels / DRAW_PIXELS_PER_INPUT_BYTE)))]);

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
const budgetMs = (reportMs: number, creditedPixels: number) => Math.ceil(Math.max(DRAW_BUDGET_FLOOR_MS, DRAW_BUDGET_REPORT_FACTOR * reportMs) + creditedPixels / DRAW_PIXELS_PER_MS);

describe('the budget of ddjvu', () => {
  it('is the floor and the drawn pixels at their rate when the file can hold them: every page for a PDF, the selected ones for images', async () => {
    given({ sizes: PAGES });
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, inputHolding(pixels(PAGES)));
    expect(drawLimitMs()).toBe(budgetMs(0, pixels(PAGES)));
    given({ sizes: PAGES }, 1);
    launch.mockClear();
    await convert('png', { timeoutMs: LONG_JOB_MS, pages: '2' }, inputHolding(pixels(PAGES)));
    expect(drawLimitMs()).toBe(budgetMs(0, pixels([PAGES[1]])));
  });

  it('counts no more pixels than the bytes of the file can hold, whatever sizes the pages declare', async () => {
    const declared: Sizes[] = Array.from({ length: 6 }, () => ({ width: DECLARED_SIDE, height: DECLARED_SIDE }));
    const input = singlePage(64, 64);
    given({ sizes: declared });
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, input);
    expect(drawLimitMs()).toBe(budgetMs(0, input.length * DRAW_PIXELS_PER_INPUT_BYTE));
    expect(drawLimitMs()).toBeLessThan(DRAW_BUDGET_FLOOR_MS + 1_000);
    given({ sizes: PAGES });
    launch.mockClear();
    const halfHeld = inputHolding(pixels(PAGES) / 2);
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, halfHeld);
    expect(drawLimitMs()).toBe(budgetMs(0, halfHeld.length * DRAW_PIXELS_PER_INPUT_BYTE));
  });

  it('is sixteen times what the work before ddjvu took, when that is more than the floor', async () => {
    const countMs = 3_000;
    given({ sizes: PAGES, countMs });
    await convert('pdf', { timeoutMs: LONG_JOB_MS }, inputHolding(pixels(PAGES)));
    expect(drawLimitMs()).toBe(budgetMs(countMs, pixels(PAGES)));
    expect(DRAW_BUDGET_REPORT_FACTOR * countMs).toBeGreaterThan(DRAW_BUDGET_FLOOR_MS);
  });

  it('is what is left of the deadline of the job when that is less', async () => {
    given({ sizes: PAGES, countMs: 3_000 });
    await convert('pdf', { timeoutMs: SHORT_JOB_MS });
    expect(drawLimitMs()).toBe(SHORT_JOB_MS - 3_000);
  });

  it('refuses a document ddjvu did not draw within the budget with the typed time-limit refusal, saying the document took too long to draw', async () => {
    const budget = budgetMs(0, pixels(PAGES));
    given({ sizes: PAGES, drawError: new SandboxedTimeoutError(budget) });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }, inputHolding(pixels(PAGES))));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', status: 422, message: `The .djvu document took too long to draw: ddjvu ran past the ${budget} ms its pages allow.` });
  });

  it('names the limit of the job, not the slice ddjvu was given, when the deadline cut the drawing', async () => {
    given({ sizes: PAGES, countMs: 3_000, drawError: new SandboxedTimeoutError(SHORT_JOB_MS - 3_000) });
    const error = await refusalOf(convert('pdf', { timeoutMs: SHORT_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', status: 422, message: expect.stringContaining(`${SHORT_JOB_MS} ms`) });
    expect(error.message).not.toContain('took too long to draw');
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
    expect(error).toMatchObject({ name: 'DjvuIncludeStructureError', status: 422, message: expect.stringContaining('exited with status 10: *** Unexpected End Of File.') });
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
