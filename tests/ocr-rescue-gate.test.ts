import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OCR_PAGE_BUDGET_ENV, OcrWorkBudget, OcrWorkLimitError } from '../src/lib/conversions/ocr-work-budget';

/**
 * The second reading of a page by the ONNX engine (policy decision 299) is an extra beside the Tesseract readings that the page
 * budget was measured on. The gate it goes through keeps it from costing another page its limit: the page's own time stands still
 * while its reading runs, and a document may spend only 5% of its time (and a start allowance of 3 s) on them. The clock is faked, so
 * the figures are the ones of the rule and not of the machine.
 */

const PAGE_BUDGET_MS = 10_000;
const PAGE_LIMIT_MS = 6 * PAGE_BUDGET_MS;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the time limit of a page and its second reading', () => {
  it('counts the page\'s own work and not the time its second reading takes', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(100);
    const page = budget.guardPage(1, async (_signal, rescue) => {
      await sleep(PAGE_LIMIT_MS - 10_000);
      await rescue.run(() => sleep(PAGE_LIMIT_MS));
      await sleep(5_000);
      return 'read';
    });
    await vi.advanceTimersByTimeAsync(2 * PAGE_LIMIT_MS);
    await expect(page).resolves.toBe('read');
  });

  it('still refuses a page whose own work passes the limit, before or after a second reading', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(100);
    const page = budget.guardPage(7, async (_signal, rescue) => {
      await sleep(PAGE_LIMIT_MS - 1_000);
      await rescue.run(() => sleep(2_000));
      await sleep(5_000);
      return 'read';
    });
    const refused = expect(page).rejects.toBeInstanceOf(OcrWorkLimitError);
    await vi.advanceTimersByTimeAsync(PAGE_LIMIT_MS + 10_000);
    await refused;
    await expect(page).rejects.toThrow(/Page 7 needs more than/);
  });

  it('still ends the page when the document has used its time during the second reading', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(40, 50 * PAGE_BUDGET_MS);
    const page = budget.guardPage(1, (_signal, rescue) => rescue.run(() => sleep(10 * PAGE_LIMIT_MS)));
    const refused = expect(page).rejects.toThrow(/Recognizing this document needs more than/);
    await vi.advanceTimersByTimeAsync(10 * PAGE_LIMIT_MS);
    await refused;
  });
});

describe('what a document may spend on second readings', () => {
  const reading = (ms: number) => async (): Promise<string> => {
    await sleep(ms);
    return 'onnx';
  };

  it('lets the first one run and refuses the next while they have used more than the allowance and 5% of the time', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(100);
    const answers: Array<string | null> = [];
    const asked = (pageNumber: number, before: number): Promise<void> =>
      budget.guardPage(pageNumber, async (_signal, rescue) => {
        await sleep(before);
        answers.push(await rescue.run(reading(3_000)));
      });
    const run = (async () => {
      await asked(1, 0);
      await asked(2, 0);
      await asked(3, 50_000);
      await asked(4, 15_000);
    })();
    await vi.advanceTimersByTimeAsync(100_000);
    await run;
    expect(answers).toEqual(['onnx', null, null, 'onnx']);
  });

  it('does not run the task of a refused reading', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(100);
    const task = vi.fn(reading(3_000));
    const page = budget.guardPage(1, async (_signal, rescue) => {
      await rescue.run(reading(3_000));
      return rescue.run(task);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await page).toBeNull();
    expect(task).not.toHaveBeenCalled();
  });

  it('does not start one when the document has less than three page budgets left', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(1, 20_000);
    const task = vi.fn(reading(1_000));
    const page = budget.guardPage(1, (_signal, rescue) => rescue.run(task));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await page).toBeNull();
    expect(task).not.toHaveBeenCalled();
  });

  it('counts the readings that are still running, so that four pages asking at once do not each get one', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(100);
    const pages = [1, 2, 3, 4].map((n) => budget.guardPage(n, (_signal, rescue) => rescue.run(reading(3_000))));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await Promise.all(pages)).filter((answer) => answer === 'onnx')).toHaveLength(1);
  });
});

describe('a page that is far on with its own work', () => {
  it('keeps the second readings of other pages away until it is done, and not after', async () => {
    vi.stubEnv(OCR_PAGE_BUDGET_ENV, String(PAGE_BUDGET_MS));
    const budget = new OcrWorkBudget(100);
    const slow = budget.guardPage(1, () => sleep(0.4 * PAGE_LIMIT_MS + 5_000));
    const answers: Array<string | null> = [];
    const other = async (): Promise<void> => {
      await budget.guardPage(2, async (_signal, rescue) => {
        await sleep(0.4 * PAGE_LIMIT_MS + 1_000);
        answers.push(await rescue.run(async () => 'onnx'));
      });
      await budget.guardPage(3, async (_signal, rescue) => {
        await sleep(10_000);
        answers.push(await rescue.run(async () => 'onnx'));
      });
    };
    const done = other();
    await vi.advanceTimersByTimeAsync(0.4 * PAGE_LIMIT_MS + 1_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([slow, done]);
    expect(answers).toEqual([null, 'onnx']);
  });
});
