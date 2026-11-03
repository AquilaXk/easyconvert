import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { convertImage } from '../src/lib/conversions/image';
import { IMAGE_DOCUMENT_MAX_PAGES } from '../src/lib/conversions/page-range';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { buildBilevelTiff } from './helpers/tiff-builder';
import { captureError } from './helpers/capture-error';
import { oracleTest } from './helpers/oracle-test';
import { SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * Free and anonymous callers have no page limit (policy entry 16): the plan of the caller never refuses a request
 * for its page count. What bounds the work is the processing deadline and the engine guards, which have one value
 * for every caller (policy entry 44: 500 pages of page images for a multi-page document).
 *
 * Oracles: the PDFs are written by pdf-lib with a known page count, the TIFFs by the hand-written writer in
 * tests/helpers/tiff-builder.ts; the page counts of the answers are read back from the ZIP entries. The 60-page TIFF
 * through every route and queue path is in tests/image-pages-routes.test.ts.
 */

const PAGES = 60;
const PAST_FREE_TIER = 51;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const TINY_SIDE = 8;
const PDF_SIDE = 100;
/** Real engine and 500-page work: the 5 s default fails on a loaded shard without any regression; this only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 120_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

async function pdfWithPages(count: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index++) document.addPage([PDF_SIDE, PDF_SIDE]);
  return Buffer.from(await document.save());
}

const tiffWithPages = (count: number) => buildBilevelTiff(Array.from({ length: count }, () => ({ width: TINY_SIDE, height: TINY_SIDE })));

async function freeKey(): Promise<string> {
  const user = await userStore.createUser({
    name: 'no tier page limit',
    email: `no_limit_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'free',
  });
  return (await redisKeyStore.generateApiKey(user.id, 'no tier page limit', { scopes: ['convert:write', 'convert:read'] })).secretKey;
}

function form(file: Buffer, filename: string, fields: Record<string, string>, key?: string): NextRequest {
  const body = new FormData();
  body.append('file', new Blob([new Uint8Array(file)]), filename);
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body,
  });
}

/** The pages an answer holds: the entries of the ZIP of `/api/convert`, or of the data URI in the JSON of `/api/v1/convert`. */
async function pagesOf(response: Response): Promise<number> {
  expect(response.status).toBe(HTTP_OK);
  let zip: Buffer;
  if (response.headers.get('content-type')?.includes('json')) {
    const body = await response.json();
    expect(body.mimeType).toBe('application/zip');
    zip = Buffer.from(String(body.dataUri).split(',')[1], 'base64');
  } else {
    zip = Buffer.from(await response.arrayBuffer());
  }
  return Object.keys((await JSZip.loadAsync(zip)).files).length;
}

let key: string;

beforeEach(async () => {
  key = await freeKey();
});

describe('a PDF past 50 pages converts to page images for a free or an anonymous caller', () => {
  const callers = [
    ['an anonymous caller', undefined],
    ['a free account', 'free'],
  ] as const;

  for (const [label, who] of callers) {
    for (const [route, handler] of [
      ['/api/convert', convertPost],
      ['/api/v1/convert', v1ConvertPost],
    ] as const) {
      if (route === '/api/v1/convert' && who === undefined) continue;
      oracleTest(
        `${label}, ${route}: pages "1-${PAGES}" of a ${PAGES}-page PDF`,
        ['pdftoppm', 'pdfinfo'],
        async () => {
          const response = await handler(form(await pdfWithPages(PAGES), 'sixty.pdf', { targetFormat: 'png', options: JSON.stringify({ pages: `1-${PAGES}` }) }, who && key));
          expect(await pagesOf(response)).toBe(PAGES);
        }
      );

      oracleTest(
        `${label}, ${route}: every page of a ${PAGES}-page PDF`,
        ['pdftoppm', 'pdfinfo'],
        async () => {
          const response = await handler(form(await pdfWithPages(PAGES), 'sixty.pdf', { targetFormat: 'png' }, who && key));
          expect(await pagesOf(response)).toBe(PAGES);
        }
      );
    }
  }

  oracleTest(
    'a page range is still checked against the page count of the document',
    ['pdftoppm', 'pdfinfo'],
    async () => {
      const response = await convertPost(form(await pdfWithPages(PAST_FREE_TIER), 'fifty-one.pdf', { targetFormat: 'png', options: JSON.stringify({ pages: '1-70' }) }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(JSON.stringify(await response.json())).toContain('exceeds document page count of 51');
    }
  );
});

describe('a page range is validated for syntax, not for the plan', () => {
  it.each([
    ['/api/convert', convertPost],
    ['/api/v1/convert', v1ConvertPost],
  ] as const)('%s refuses a reversed range', async (_route, handler) => {
    const response = await handler(form(await pdfWithPages(2), 'two.pdf', { targetFormat: 'png', options: JSON.stringify({ pages: '5-2' }) }, key));
    expect([HTTP_BAD_REQUEST, HTTP_UNPROCESSABLE]).toContain(response.status);
    expect(JSON.stringify(await response.json())).toMatch(/cannot exceed range end|Range 5-2/);
  });

  it('/api/v1/jobs accepts a range past 50 pages for a free account', async () => {
    const request = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'sixty.pdf',
        targetFormat: 'png',
        options: { pages: `1-${PAGES}` },
        inputBufferBase64: (await pdfWithPages(PAGES)).toString('base64'),
        fileSize: 1,
      }),
    });
    const response = await v1JobsPost(request);
    expect(response.status).not.toBe(HTTP_UNPROCESSABLE);
    expect(JSON.stringify(await response.json())).not.toMatch(/maximum allowed|for tier/);
  });
});

describe('the engine guard of a multi-page image has one value for every caller', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('refuses a document past the guard, whatever the options carry', async () => {
    expect(IMAGE_DOCUMENT_MAX_PAGES).toBe(500);
    const error = await captureError(() => convertImage(tiffWithPages(IMAGE_DOCUMENT_MAX_PAGES + 1), 'png', { maxPages: 100000 } as never, 'many.tif', 'tiff'));
    expect(error.name).toBe('InvalidPageRangeError');
    expect(error.message).toContain(`limit of ${IMAGE_DOCUMENT_MAX_PAGES} pages`);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each([
    ['an anonymous caller', undefined],
    ['a free account', 'free'],
  ] as const)('%s is refused a document past the guard with the same typed answer', async (_label, who) => {
    const response = await convertPost(form(tiffWithPages(IMAGE_DOCUMENT_MAX_PAGES + 1), 'many.tif', { targetFormat: 'png' }, who && key));
    expect(response.status).toBe(HTTP_BAD_REQUEST);
    expect(JSON.stringify(await response.json())).toContain(`limit of ${IMAGE_DOCUMENT_MAX_PAGES} pages`);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a selection within the guard of a longer document is accepted', async () => {
    const result = await convertImage(tiffWithPages(IMAGE_DOCUMENT_MAX_PAGES + 1), 'png', { pages: `1-${PAGES}` }, 'many.tif', 'tiff');
    expect(Object.keys((await JSZip.loadAsync(result.buffer)).files)).toHaveLength(PAGES);
  });
});
