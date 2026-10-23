import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import { picturePdf } from './helpers/picture-pdf';

/**
 * pdf.js keeps what it decoded for a page (`page.objs`) until the page is cleaned up. The decoded pixels are typed arrays outside
 * the V8 heap, so the thread's heap limit does not see them: a document of many large pictures grows the process by the sum of
 * all of them unless the reader cleans each page once it is read.
 */

const CHILD = path.resolve(__dirname, 'pdf-picture-memory-child.ts');
const PAGES = 60;
const DIMENSION = 3000;
/** Measured on 60 pages: about 650 MiB with cleanup, whatever the page count (the encoder and libvips are most of that), and about 1.8 GiB without. */
const RSS_BUDGET_MIB = 1000;
const CHILD_TIMEOUT_MS = 180_000;

function peakRssMiB(pages: number): { pictures: number; rss: number } {
  const output = execFileSync(process.execPath, ['--import', 'tsx', CHILD, String(pages), String(DIMENSION)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CHILD_TIMEOUT_MS });
  const [, pictures, rss] = /^ok (\d+) pictures, peak rss (\d+) MiB/.exec(output) ?? [];
  return { pictures: Number(pictures), rss: Number(rss) };
}

describe('a PDF with a large picture on each of many pages', () => {
  it(`reads ${PAGES} pages of ${DIMENSION}x${DIMENSION} pictures without holding every decoded page at once`, () => {
    const { pictures, rss } = peakRssMiB(PAGES);
    expect(pictures).toBe(PAGES);
    expect(rss).toBeLessThan(RSS_BUDGET_MIB);
  }, CHILD_TIMEOUT_MS + 5_000);
});

describe('a picture that every page of a PDF paints', () => {
  it('is found on each page after the page before it was cleaned up', async () => {
    const pages = 8;
    const drawsPerPage = 3;
    const bytes = picturePdf({ pages, drawsPerPage, dimension: 16, sharedPicture: true });
    const result = await analyzePdfPagesInProcess(bytes, { geometry: 'none', content: true, images: true });
    expect(result.content.map((page) => page.images.filter((image) => image.data !== undefined).length)).toEqual(Array(pages).fill(drawsPerPage));
  });
});
