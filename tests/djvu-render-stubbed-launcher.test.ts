import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertDjvu, drawBudgetMs, type DjvuJob } from '../src/worker/djvu-render';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/worker/sandbox';
import { singlePage } from './helpers/djvu-builder';

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
const BUDGET_FLOOR_MS = 15_000;
const PIXELS_PER_MS = 12_500;
const SIZE_RUN_LIMIT_MS = 120_000;
const MEMORY_LIMIT_MB = 2048;

interface Sizes {
  readonly width: number;
  readonly height: number;
}

/** What each program does when the chain starts it: the time it takes on the clock, and what it prints or throws. */
interface Programs {
  readonly sizes: readonly Sizes[];
  readonly countMs?: number;
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

function stubPrograms(programs: Programs): void {
  launch.mockImplementation(async (binary: string, args: string[]) => {
    if (path.basename(binary) === 'djvused' && args[1] === 'n') {
      clock += programs.countMs ?? 0;
      return { stdout: Buffer.from(`${programs.sizes.length}\n`) };
    }
    if (path.basename(binary) === 'djvused' && args[1] === 'size') {
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

async function convert(tgt: string, options: DjvuJob['options'] = {}): Promise<unknown> {
  countPdfPages.mockReset();
  countPdfPages.mockImplementation(async () => drawnPages);
  return convertDjvu({
    input: singlePage(64, 64),
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
const drawLimitMs = (): number | undefined => (drawCall()?.[2] as { timeoutMs?: number } | undefined)?.timeoutMs;

const refusalOf = async (conversion: Promise<unknown>): Promise<Error> => {
  const outcome = await conversion.then(
    () => null,
    (error: unknown) => error
  );
  if (!(outcome instanceof Error)) throw new Error('the conversion was not refused');
  return outcome;
};

const PAGES: readonly Sizes[] = [
  { width: 10_000, height: 10_000 },
  { width: 5_000, height: 5_000 },
  { width: 64, height: 64 },
];
const pixels = (pages: readonly Sizes[]) => pages.reduce((sum, page) => sum + page.width * page.height, 0);

describe('the budget of ddjvu', () => {
  it('is the 15 s floor and the drawn pixels at 12.5 megapixels a second: every page for a PDF, the selected ones for images', async () => {
    given({ sizes: PAGES });
    await convert('pdf', { timeoutMs: LONG_JOB_MS });
    expect(drawLimitMs()).toBe(Math.ceil(BUDGET_FLOOR_MS + pixels(PAGES) / PIXELS_PER_MS));
    given({ sizes: PAGES }, 1);
    launch.mockClear();
    await convert('png', { timeoutMs: LONG_JOB_MS, pages: '2' });
    expect(drawLimitMs()).toBe(BUDGET_FLOOR_MS + pixels([PAGES[1]]) / PIXELS_PER_MS);
  });

  it('is eight times what the djvused runs took, when that is more than the floor', async () => {
    const countMs = 3_000;
    given({ sizes: PAGES, countMs });
    await convert('pdf', { timeoutMs: LONG_JOB_MS });
    expect(drawLimitMs()).toBe(Math.ceil(8 * countMs + pixels(PAGES) / PIXELS_PER_MS));
    expect(drawBudgetMs(countMs, pixels(PAGES))).toBe(drawLimitMs());
  });

  it('is what is left of the deadline of the job when that is less', async () => {
    given({ sizes: PAGES, countMs: 3_000 });
    await convert('pdf', { timeoutMs: SHORT_JOB_MS });
    expect(drawLimitMs()).toBe(SHORT_JOB_MS - 3_000);
  });

  it('refuses a document ddjvu did not draw within the budget with the typed time-limit refusal, saying the document took too long to draw', async () => {
    const budgetMs = Math.ceil(BUDGET_FLOOR_MS + pixels(PAGES) / PIXELS_PER_MS);
    given({ sizes: PAGES, drawError: new SandboxedTimeoutError(budgetMs) });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', status: 422, message: `The .djvu document took too long to draw: ddjvu ran past the ${budgetMs} ms its pages allow.` });
  });

  it('names the limit of the job, not the slice ddjvu was given, when the deadline cut the drawing', async () => {
    given({ sizes: PAGES, countMs: 3_000, drawError: new SandboxedTimeoutError(SHORT_JOB_MS - 3_000) });
    const error = await refusalOf(convert('pdf', { timeoutMs: SHORT_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', status: 422, message: expect.stringContaining(`${SHORT_JOB_MS} ms`) });
    expect(error.message).not.toContain('took too long to draw');
  });
});

describe('the page count of the PDF', () => {
  it('is not started with less than two seconds of the deadline left: the deadline answers, with the limit of the job', async () => {
    given({ sizes: [PAGES[2]], drawMs: SHORT_JOB_MS - 1_500 });
    const error = await refusalOf(convert('pdf', { timeoutMs: SHORT_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', message: expect.stringContaining(`${SHORT_JOB_MS} ms`) });
    expect(countPdfPages).not.toHaveBeenCalled();
  });

  it('is started with two seconds or more left', async () => {
    given({ sizes: [PAGES[2]], drawMs: SHORT_JOB_MS - 2_000 });
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
    ['printed more than its output limit', new SandboxedBufferLimitError(16 * 1024 * 1024)],
  ])('is not a verdict on the document when the run %s', async (_name, sizeError) => {
    given({ sizes: [PAGES[2]], sizeError });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error.name).not.toBe('DjvuIncludeStructureError');
    expect(error.message).not.toContain('include structure');
    expect(drawCall()).toBeUndefined();
  });

  it.each([
    ['faulted under the address space limit (SIGSEGV)', new SandboxedMemoryLimitError(MEMORY_LIMIT_MB, 'SIGSEGV'), 'crashed (SIGSEGV) under its 2048 MB memory limit'],
    ['faulted without a memory limit (SIGSEGV)', new SandboxedProcessError('Process terminated by signal SIGSEGV', null, '', 'SIGSEGV'), 'crashed (SIGSEGV)'],
    ['raised a floating point exception (SIGFPE)', new SandboxedProcessError('Process terminated by signal SIGFPE', null, '', 'SIGFPE'), 'crashed (SIGFPE)'],
    ['hit an illegal instruction (SIGILL)', new SandboxedProcessError('Process terminated by signal SIGILL', null, '', 'SIGILL'), 'crashed (SIGILL)'],
    ['exited with a status other than zero', new SandboxedProcessError('*** Unexpected End Of File.', 10, '*** Unexpected End Of File.'), 'exited with status 10: *** Unexpected End Of File.'],
  ])('refuses the include structure of a document when the program %s', async (_name, sizeError, how) => {
    given({ sizes: [PAGES[2]], sizeError });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error).toMatchObject({ name: 'DjvuIncludeStructureError', status: 422, message: expect.stringContaining(how) });
    expect(drawCall()).toBeUndefined();
  });

  it('refuses a document whose pages djvused could not open within its own limit, saying so', async () => {
    given({ sizes: [PAGES[2]], sizeError: new SandboxedTimeoutError(SIZE_RUN_LIMIT_MS) });
    const error = await refusalOf(convert('pdf', { timeoutMs: LONG_JOB_MS }));
    expect(error).toMatchObject({ name: 'DjvuIncludeStructureError', status: 422, message: `djvused could not open the pages of the DjVu document within its ${SIZE_RUN_LIMIT_MS} ms limit.` });
    expect((launch.mock.calls.find(([, args]) => (args as string[])[1] === 'size')?.[2] as { timeoutMs: number }).timeoutMs).toBe(SIZE_RUN_LIMIT_MS);
  });

  it('names the limit of the job when the deadline cut the size run', async () => {
    given({ sizes: [PAGES[2]], sizeError: new SandboxedTimeoutError(SHORT_JOB_MS) });
    const error = await refusalOf(convert('pdf', { timeoutMs: SHORT_JOB_MS }));
    expect(error).toMatchObject({ name: 'CpuTaskTimeoutError', message: expect.stringContaining(`${SHORT_JOB_MS} ms`) });
  });
});
