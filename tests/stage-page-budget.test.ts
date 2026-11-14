import { describe, expect, it } from 'vitest';
import { bindJobLimits, OFFICE_STAGE, pagedStageTimeoutMs, PAGE_LOOP_STAGE, sizedStageTimeoutMs } from '../src/lib/conversions/job-time';
import { pageLoopBudget } from '../src/worker/page-loop-budget';
import { SandboxedTimeoutError } from '../src/worker/sandbox';

/**
 * A stage that works through the pages of one document (the re-encoding of rendered pages, the drawing of SVG and EPS pages) is limited by
 * the pages it has to do: its own default for a short document, a per-page budget for a long one, never past the time the job has left.
 * The limit of one process of the stage is not part of this: it stays what the stage default says.
 */

const SECOND = 1000;
const NOW = 1_000_000;
const signal = new AbortController().signal;
const deadlineIn = (ms: number) => bindJobLimits({}, { signal, deadlineAt: NOW + ms });

describe('pagedStageTimeoutMs', () => {
  it('keeps the stage default for a document whose pages fit in it', () => {
    expect(PAGE_LOOP_STAGE).toEqual({ defaultMs: 45 * SECOND, maxMs: 120 * SECOND, perPageMs: 2 * SECOND, pagedMaxMs: 60 * 60 * SECOND });
    expect(pagedStageTimeoutMs(undefined, 1, PAGE_LOOP_STAGE, NOW)).toBe(45 * SECOND);
    expect(pagedStageTimeoutMs(undefined, 22, PAGE_LOOP_STAGE, NOW)).toBe(45 * SECOND);
  });

  it('grows with the pages once they cost more than the default, 2 s for each', () => {
    expect(pagedStageTimeoutMs(undefined, 23, PAGE_LOOP_STAGE, NOW)).toBe(46 * SECOND);
    expect(pagedStageTimeoutMs(undefined, 657, PAGE_LOOP_STAGE, NOW)).toBe(1314 * SECOND);
  });

  it('never passes the absolute ceiling', () => {
    expect(pagedStageTimeoutMs(undefined, 100_000, PAGE_LOOP_STAGE, NOW)).toBe(60 * 60 * SECOND);
  });

  it('is held to the time the job has left, long or short', () => {
    expect(pagedStageTimeoutMs(deadlineIn(300 * SECOND), 657, PAGE_LOOP_STAGE, NOW)).toBe(300 * SECOND);
    expect(pagedStageTimeoutMs(deadlineIn(10 * SECOND), 3, PAGE_LOOP_STAGE, NOW)).toBe(10 * SECOND);
    expect(pagedStageTimeoutMs(deadlineIn(-5 * SECOND), 3, PAGE_LOOP_STAGE, NOW)).toBe(1);
  });

  it('treats a server-set timeoutMs as the limit, under the old ceiling and the job time, whatever the pages', () => {
    expect(pagedStageTimeoutMs({ timeoutMs: 30 * SECOND }, 657, PAGE_LOOP_STAGE, NOW)).toBe(30 * SECOND);
    expect(pagedStageTimeoutMs({ timeoutMs: 900 * SECOND }, 657, PAGE_LOOP_STAGE, NOW)).toBe(120 * SECOND);
    expect(pagedStageTimeoutMs({ ...deadlineIn(20 * SECOND), timeoutMs: 90 * SECOND }, 657, PAGE_LOOP_STAGE, NOW)).toBe(20 * SECOND);
  });

  it('counts a missing or invalid page count as one page', () => {
    for (const pages of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pagedStageTimeoutMs(undefined, pages, PAGE_LOOP_STAGE, NOW)).toBe(45 * SECOND);
    }
  });
});

const MEGABYTE = 1024 * 1024;

describe('sizedStageTimeoutMs of the office suite run', () => {
  it('keeps 120 s for an input of up to 2 MB, a small one included', () => {
    expect(OFFICE_STAGE).toEqual({ defaultMs: 120 * SECOND, maxMs: 120 * SECOND, perMegabyteMs: 60 * SECOND, sizedMaxMs: 60 * 60 * SECOND });
    for (const bytes of [0, 1, 40 * 1024, MEGABYTE, 2 * MEGABYTE]) expect(sizedStageTimeoutMs(undefined, bytes, OFFICE_STAGE, NOW)).toBe(120 * SECOND);
  });

  it('grows with the input, 60 s for each megabyte', () => {
    expect(sizedStageTimeoutMs(undefined, 3 * MEGABYTE, OFFICE_STAGE, NOW)).toBe(180 * SECOND);
    expect(sizedStageTimeoutMs(undefined, 7.5 * MEGABYTE, OFFICE_STAGE, NOW)).toBe(450 * SECOND);
  });

  it('never passes the absolute ceiling and is held to the time the job has left', () => {
    expect(sizedStageTimeoutMs(undefined, 5000 * MEGABYTE, OFFICE_STAGE, NOW)).toBe(60 * 60 * SECOND);
    expect(sizedStageTimeoutMs(deadlineIn(300 * SECOND), 40 * MEGABYTE, OFFICE_STAGE, NOW)).toBe(300 * SECOND);
    expect(sizedStageTimeoutMs(deadlineIn(10 * SECOND), 1, OFFICE_STAGE, NOW)).toBe(10 * SECOND);
  });

  it('treats a server-set timeoutMs as the limit, under 120 s and the job time, whatever the size', () => {
    expect(sizedStageTimeoutMs({ timeoutMs: 30 * SECOND }, 40 * MEGABYTE, OFFICE_STAGE, NOW)).toBe(30 * SECOND);
    expect(sizedStageTimeoutMs({ timeoutMs: 900 * SECOND }, 40 * MEGABYTE, OFFICE_STAGE, NOW)).toBe(120 * SECOND);
    expect(sizedStageTimeoutMs({ ...deadlineIn(20 * SECOND), timeoutMs: 90 * SECOND }, 40 * MEGABYTE, OFFICE_STAGE, NOW)).toBe(20 * SECOND);
  });

  it('counts a size that is not a positive number as no size', () => {
    for (const bytes of [-5, Number.NaN, Number.POSITIVE_INFINITY]) expect(sizedStageTimeoutMs(undefined, bytes, OFFICE_STAGE, NOW)).toBe(120 * SECOND);
  });
});

describe('pageLoopBudget', () => {
  it('hands each process the time the loop has left, never more than the stage limit of one process', () => {
    const budget = pageLoopBudget(undefined, 600, 45 * SECOND);
    expect(budget.remainingMs()).toBe(45 * SECOND);
    const short = pageLoopBudget(bindJobLimits({}, { signal, deadlineAt: Date.now() + 8 * SECOND }), 600, 45 * SECOND);
    expect(short.remainingMs()).toBeLessThanOrEqual(8 * SECOND);
    expect(short.remainingMs()).toBeGreaterThan(7 * SECOND);
  });

  it('throws the sandbox timeout, naming the limit of the loop, once that has passed', async () => {
    const budget = pageLoopBudget({ timeoutMs: 5 }, 600, 45 * SECOND);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => budget.remainingMs()).toThrow(new SandboxedTimeoutError(5));
  });
});
