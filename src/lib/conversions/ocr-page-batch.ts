import { OCR_POOL_MAX_WORKERS_TOTAL } from './ocr-worker-pool';

/**
 * Pages of one PDF are recognized side by side instead of one after another. Each page in flight
 * holds its decoded pixels, a prepared copy and the engine's working memory, so the number is
 * bounded; results are always returned in the order of the input pages.
 */

/**
 * Most pages of one document in flight at once. A decoded 300 dpi letter page is about 8 MB and its
 * preparation and recognition hold a few copies, so this keeps a document well inside the memory
 * budget of one request; the pool and CLI limits below it bound it further.
 */
export const OCR_MAX_INFLIGHT_PAGES = 4;
export const OCR_PAGE_CONCURRENCY_ENV = 'EASYCONVERT_OCR_PAGE_CONCURRENCY';

export function ocrPageConcurrency(poolCapacity: number = OCR_POOL_MAX_WORKERS_TOTAL): number {
  const upper = Math.max(1, Math.min(poolCapacity, OCR_MAX_INFLIGHT_PAGES));
  const override = Number(process.env[OCR_PAGE_CONCURRENCY_ENV]);
  return Number.isInteger(override) && override > 0 ? Math.min(upper, override) : upper;
}

/**
 * Runs `task` over `items` with at most `limit` running at once and returns the results in the
 * order of `items`, however the tasks finish. After the first failure no further task is started;
 * tasks already running finish, and the first error is rethrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Concurrency must be a positive integer, got ${limit}.`);
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const runner = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}
