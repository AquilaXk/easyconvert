import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizeRenderedPdfPages, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { OcrWorkBudget, OcrWorkLimitError } from '../src/lib/conversions/ocr-work-budget';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { JOB_DEADLINE_AT, bindJobLimits } from '../src/lib/conversions/job-time';
import { JobTimeoutError } from '../src/lib/types';
import { requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';

/**
 * OCR runs under the job's deadline: the job's signal ends the pages in flight and kills the render and the
 * Tesseract processes, and the share of the deadline the OCR may use is taken from the time the job has left.
 */

const TEST_TIMEOUT_MS = 120_000;
const PAGES = 40;
const LINES_PER_PAGE = 28;
const SENTENCE = 'The committee reviewed the quarterly report and approved the budget for the regional water project';

afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdownOcrWorkerPool();
});

async function textPages(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < pageCount; page++) {
    const sheet = doc.addPage([612, 792]);
    for (let line = 0; line < LINES_PER_PAGE; line++) {
      sheet.drawText(`${SENTENCE} (page ${page + 1}, line ${line + 1}).`, { x: 36, y: 750 - line * 24, size: 11, font });
    }
  }
  return Buffer.from(await doc.save());
}

/** Commands of the OCR tools that are still children of this process. */
function ocrChildren(): string[] {
  let pids: string[] = [];
  try {
    pids = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return pids
    .map((pid) => {
      try {
        return execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    })
    .filter((command) => /tesseract|pdftoppm/.test(command));
}

async function noOcrChildrenWithin(limitMs: number): Promise<boolean> {
  const stop = Date.now() + limitMs;
  while (Date.now() < stop) {
    if (ocrChildren().length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ocrChildren().length === 0;
}

describe('the OCR work budget follows the job signal', () => {
  it('starts no page for a job that is already over, and ends with the job signal reason', async () => {
    const job = new AbortController();
    job.abort(new JobTimeoutError(1000));
    const budget = new OcrWorkBudget(3, undefined, job.signal);
    const work = vi.fn(async () => 'page');
    await expect(budget.guardPage(1, work)).rejects.toBeInstanceOf(JobTimeoutError);
    expect(work).not.toHaveBeenCalled();
  });

  it('ends a page that ignores its signal when the job signal fires, with the job reason, not a work limit', async () => {
    const job = new AbortController();
    const budget = new OcrWorkBudget(3, undefined, job.signal);
    let pageSignal: AbortSignal | undefined;
    const page = budget.guardPage(1, (signal) => {
      pageSignal = signal;
      return new Promise<string>(() => undefined);
    });
    const outcome = page.then(
      () => 'resolved',
      (error: unknown) => error
    );
    job.abort(new JobTimeoutError(1000));
    const error = await outcome;
    expect(error).toBeInstanceOf(JobTimeoutError);
    expect(error).not.toBeInstanceOf(OcrWorkLimitError);
    expect(pageSignal?.aborted).toBe(true);
    expect(pageSignal?.reason).toBeInstanceOf(JobTimeoutError);
  });

  it('is not affected by a job signal that never fires', async () => {
    const job = new AbortController();
    const budget = new OcrWorkBudget(2, undefined, job.signal);
    await expect(budget.guardPage(1, async () => 'a')).resolves.toBe('a');
    await expect(budget.guardPage(2, async () => 'b')).resolves.toBe('b');
  });
});

describe('OCR of a PDF under a job deadline', () => {
  oracleTest(
    'stops at the job signal: the call ends with the deadline error and no render or Tesseract process is left',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      const pdf = await textPages(PAGES);
      const job = new AbortController();
      const startedAt = Date.now();
      const timer = setTimeout(() => job.abort(new JobTimeoutError(1500)), 1500);
      const outcome = await recognizeRenderedPdfPages(pdf, undefined, { signal: job.signal }).then(
        () => null,
        (error: unknown) => error
      );
      clearTimeout(timer);
      expect(outcome).toBeInstanceOf(JobTimeoutError);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(await noOcrChildrenWithin(10_000)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a conversion bound to the job stops at the deadline signal through the dispatcher, and the OCR budget uses only the time left',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      const pdf = await textPages(PAGES);
      const job = new AbortController();
      const timer = setTimeout(() => job.abort(new JobTimeoutError(2000)), 2000);
      const options = bindJobLimits({ ocrEnabled: true, ocrMode: 'force' as const }, { signal: job.signal, deadlineAt: Date.now() + 600_000 });
      const outcome = await dispatchConversion(pdf, 'pdf', 'txt', options, 'long.pdf').then(
        () => null,
        (error: unknown) => error
      );
      clearTimeout(timer);
      expect(outcome).toBeInstanceOf(JobTimeoutError);
      expect(await noOcrChildrenWithin(10_000)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'limits the OCR of a long document to 90 percent of the time the job has left, as a typed 413 before the deadline',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      const pdf = await textPages(PAGES);
      const leftMs = 4_000;
      const options = bindJobLimits({ ocrEnabled: true, ocrMode: 'force' as const }, {
        signal: new AbortController().signal,
        deadlineAt: Date.now() + leftMs,
      });
      expect(typeof (options as unknown as Record<symbol, unknown>)[JOB_DEADLINE_AT]).toBe('number');
      const startedAt = Date.now();
      const outcome = await dispatchConversion(pdf, 'pdf', 'txt', options, 'long.pdf').then(
        () => null,
        (error: unknown) => error
      );
      expect(outcome).toBeInstanceOf(OcrWorkLimitError);
      expect(Date.now() - startedAt).toBeLessThan(leftMs + 8_000);
      const allowed = Number(/more than the (\d+) ms allowed/.exec((outcome as Error).message)?.[1]);
      expect(allowed).toBeLessThanOrEqual(Math.floor(leftMs * 0.9));
      expect(allowed).toBeGreaterThan(2_000);
    },
    TEST_TIMEOUT_MS
  );
});
