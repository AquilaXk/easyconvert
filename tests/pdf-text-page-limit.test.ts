import { describe, expect, it, vi } from 'vitest';
import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import { PDF_TEXT_MAX_PAGES } from '../src/lib/conversions/pdf-text-types';
import { rawPdf, run } from './helpers/raw-pdf';

/**
 * The page limit of the text reader holds for every job that reads every page, not only for one that asks for the content: a
 * density analysis or the geometry of every page keeps a record for each page it reads.
 */

/** Hang guard only: a document of 2,001 pages is refused as soon as its page count is known. */
const PAGE_LIMIT_HANG_GUARD_MS = 30_000;
vi.setConfig({ testTimeout: PAGE_LIMIT_HANG_GUARD_MS });

const pages = (count: number) => Array.from({ length: count }, (_, at) => ({ width: 100, height: 100, content: run(`Page ${at}`, 10, 50, 12) }));
const tooMany = rawPdf(pages(PDF_TEXT_MAX_PAGES + 1));

describe('a PDF of more pages than the text reader reads', () => {
  it.each([
    ['the density of every page', { densityThreshold: 15, geometry: 'none' as const }],
    ['the geometry of every page that has text', { geometry: 'text-pages' as const }],
    ['the content', { geometry: 'none' as const, content: true as const }],
  ])('is refused when the job reads %s', async (_what, job) => {
    await expect(analyzePdfPagesInProcess(tooMany, job)).rejects.toMatchObject({ name: 'PayloadLimitError', message: `PDF has ${PDF_TEXT_MAX_PAGES + 1} pages; at most ${PDF_TEXT_MAX_PAGES} can be read.` });
  });

  it('is read for the pages a job names', async () => {
    const result = await analyzePdfPagesInProcess(tooMany, { geometry: [1, 2] });
    expect([...result.geometry.keys()]).toEqual([1, 2]);
  });
});
