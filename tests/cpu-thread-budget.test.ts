import { describe, expect, it } from 'vitest';
import { CpuThreadBudget } from '../src/lib/workers/cpu-thread-budget';
import { defaultPdfTextPoolLimit } from '../src/lib/conversions/pdf-text-host';
import { defaultOcrPoolMaxWorkersTotal } from '../src/lib/conversions/ocr-worker-pool';

describe('CpuThreadBudget and elastic Scale-Up pool sizing', () => {
  it('grants full desired threads when uncontended and prevents W x T oversubscription under contention', () => {
    const budget = new CpuThreadBudget(() => 8);
    expect(budget.stats).toEqual({ capacity: 8, claimedTokens: 0, activeLeases: 0 });

    const first = budget.acquire(6);
    expect(first.threads).toBe(6);
    expect(budget.stats).toEqual({ capacity: 8, claimedTokens: 6, activeLeases: 1 });

    // Second concurrent slot gets the remaining 2 cores rather than 6.
    const second = budget.acquire(6);
    expect(second.threads).toBe(2);
    expect(budget.stats).toEqual({ capacity: 8, claimedTokens: 8, activeLeases: 2 });

    // Third concurrent slot never deadlocks; falls back to 1 thread (imgproxy vips_concurrency_set(1) mode).
    const third = budget.acquire(8);
    expect(third.threads).toBe(1);
    expect(budget.stats).toEqual({ capacity: 8, claimedTokens: 8, activeLeases: 3 });

    // Releasing is idempotent and restores capacity for subsequent jobs.
    first.release();
    first.release();
    expect(budget.stats).toEqual({ capacity: 8, claimedTokens: 2, activeLeases: 2 });

    const fourth = budget.acquire(8);
    expect(fourth.threads).toBe(6);

    second.release();
    third.release();
    fourth.release();
    expect(budget.stats).toEqual({ capacity: 8, claimedTokens: 0, activeLeases: 0 });
  });

  it('allows a single uncontended job to exceed nominal core count (e.g. x264 16 threads on 12 cores) while clamping claimed tokens', async () => {
    const budget = new CpuThreadBudget(() => 12);
    const seen: number[] = [];

    await budget.run(16, async (firstThreads) => {
      seen.push(firstThreads);
      expect(budget.stats).toEqual({ capacity: 12, claimedTokens: 12, activeLeases: 1 });
      await budget.run(8, async (secondThreads) => {
        seen.push(secondThreads);
      });
    });

    expect(seen).toEqual([16, 1]);
    expect(budget.stats).toEqual({ capacity: 12, claimedTokens: 0, activeLeases: 0 });
  });

  it('scales PDF text and WASM OCR total worker pools with cores and memory up to 16', () => {
    expect(defaultPdfTextPoolLimit(4, 14 * 1024 ** 3)).toBe(4);
    expect(defaultPdfTextPoolLimit(16, 32 * 1024 ** 3)).toBe(16);
    expect(defaultPdfTextPoolLimit(32, 6 * 1024 ** 3)).toBe(6);

    expect(defaultOcrPoolMaxWorkersTotal(4, 14 * 1024 ** 3)).toBe(4);
    expect(defaultOcrPoolMaxWorkersTotal(16, 16 * 1024 ** 3)).toBe(16);
    expect(defaultOcrPoolMaxWorkersTotal(16, 3 * 1024 ** 3)).toBe(6);
  });
});
