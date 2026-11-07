import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { convertPdfPagesWithNativeTools, executeWorkerConversion } from '../src/worker/engines';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { buildBilevelTiff } from './helpers/tiff-builder';
import { oracleTest } from './helpers/oracle-test';
import { SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { captureError } from './helpers/capture-error';

/**
 * Free and anonymous callers have no page limit (policy entry 16): the plan of the caller never refuses a request
 * for its page count. What bounds the work is the processing deadline and the engine guards, which have one value
 * for every caller (policy entry 44: 500 pages of page images for a multi-page document, a PDF included).
 *
 * Oracles: the PDFs are written by pdf-lib with a known page count, the TIFFs by the hand-written writer in
 * tests/helpers/tiff-builder.ts; the page counts of the answers are read back from the ZIP entries. The 60-page TIFF
 * through every route and queue path is in tests/image-pages-routes.test.ts.
 */

const SIXTY_PAGES = 60;
const FIFTY_ONE_PAGES = 51;
const FIVE_HUNDRED_PAGES = 500;
const FIVE_HUNDRED_AND_ONE_PAGES = 501;
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
const LONGEST_SPEC_CHARS = 8192;
const TINY_SIDE = 8;
const PDF_SIDE = 100;
/** Real engine work on a few dozen pages: the 5 s default fails on a loaded shard without any regression; this only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
/** Poppler draws 500 pages and the TIFF path decodes and encodes 500 pages; this only stops a hang. */
const LIMIT_DOCUMENT_TIMEOUT_MS = 180_000;

async function pdfWithPages(count: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index++) document.addPage([PDF_SIDE, PDF_SIDE]);
  return Buffer.from(await document.save());
}

const tiffWithPages = (count: number) => buildBilevelTiff(Array.from({ length: count }, () => ({ width: TINY_SIDE, height: TINY_SIDE })));

async function keyOfTier(tier: 'free' | 'enterprise'): Promise<string> {
  const user = await userStore.createUser({
    name: 'no tier page limit',
    email: `no_limit_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier,
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
  key = await keyOfTier('free');
});

const ANONYMOUS_AND_FREE = [
  ['an anonymous caller', undefined],
  ['a free account', 'free'],
] as const;

describe('a PDF past 50 pages converts to page images for a free or an anonymous caller', () => {
  for (const [label, who] of ANONYMOUS_AND_FREE) {
    for (const [route, handler] of [
      ['/api/convert', convertPost],
      ['/api/v1/convert', v1ConvertPost],
    ] as const) {
      if (route === '/api/v1/convert' && who === undefined) continue;
      oracleTest(
        `${label}, ${route}: pages "1-${SIXTY_PAGES}" of a ${SIXTY_PAGES}-page PDF`,
        ['pdftoppm', 'pdfinfo'],
        async () => {
          const response = await handler(form(await pdfWithPages(SIXTY_PAGES), 'sixty.pdf', { targetFormat: 'png', options: JSON.stringify({ pages: `1-${SIXTY_PAGES}` }) }, who && key));
          expect(await pagesOf(response)).toBe(SIXTY_PAGES);
        },
        ENGINE_TEST_TIMEOUT_MS
      );

      oracleTest(
        `${label}, ${route}: every page of a ${SIXTY_PAGES}-page PDF`,
        ['pdftoppm', 'pdfinfo'],
        async () => {
          const response = await handler(form(await pdfWithPages(SIXTY_PAGES), 'sixty.pdf', { targetFormat: 'png' }, who && key));
          expect(await pagesOf(response)).toBe(SIXTY_PAGES);
        },
        ENGINE_TEST_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'a page range is still checked against the page count of the document',
    ['pdftoppm', 'pdfinfo'],
    async () => {
      const response = await convertPost(form(await pdfWithPages(FIFTY_ONE_PAGES), 'fifty-one.pdf', { targetFormat: 'png', options: JSON.stringify({ pages: '1-70' }) }));
      expect(response.status).toBeGreaterThanOrEqual(HTTP_BAD_REQUEST);
      expect(response.status).toBeLessThan(HTTP_INTERNAL_ERROR);
      expect(JSON.stringify(await response.json())).toContain('exceeds document page count of 51');
    },
    ENGINE_TEST_TIMEOUT_MS
  );
});

describe('the engine guard of PDF page images has one value for every caller', () => {
  for (const [label, who] of ANONYMOUS_AND_FREE) {
    for (const [what, options] of [
      ['without a page range', {}],
      ['with a range of every page', { pages: `1-${FIVE_HUNDRED_AND_ONE_PAGES}` }],
    ] as const) {
      oracleTest(
        `${label} is refused ${FIVE_HUNDRED_AND_ONE_PAGES} selected pages ${what}, with the limit and the ways out`,
        ['pdftoppm', 'pdfinfo'],
        async () => {
          const response = await convertPost(form(await pdfWithPages(FIVE_HUNDRED_AND_ONE_PAGES), 'long.pdf', { targetFormat: 'png', options: JSON.stringify(options) }, who && key));
          expect(response.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
          const body = JSON.stringify(await response.json());
          expect(body).toContain(`${FIVE_HUNDRED_AND_ONE_PAGES} pages`);
          expect(body).toContain(`at most ${FIVE_HUNDRED_PAGES}`);
          expect(body).toContain('multiPageOutput');
        },
        ENGINE_TEST_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'a request cannot lift the guard with an option of its own',
    ['pdftoppm', 'pdfinfo'],
    async () => {
      const response = await convertPost(form(await pdfWithPages(FIVE_HUNDRED_AND_ONE_PAGES), 'long.pdf', { targetFormat: 'png', options: JSON.stringify({ maxRenderedPages: 100000 }) }));
      expect(response.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    },
    ENGINE_TEST_TIMEOUT_MS
  );

  oracleTest(
    `${FIVE_HUNDRED_PAGES} selected pages are accepted, whether the document has them all or a selection picks them`,
    ['pdftoppm', 'pdfinfo'],
    async () => {
      const longer = await pdfWithPages(FIVE_HUNDRED_AND_ONE_PAGES);
      const selected = await executeWorkerConversion(longer, 'pdf', 'png', { pages: `2-${FIVE_HUNDRED_AND_ONE_PAGES}` }, 'long.pdf');
      expect(Object.keys((await JSZip.loadAsync(selected.buffer)).files)).toHaveLength(FIVE_HUNDRED_PAGES);
      const whole = await executeWorkerConversion(await pdfWithPages(FIVE_HUNDRED_PAGES), 'pdf', 'png', {}, 'whole.pdf');
      expect(Object.keys((await JSZip.loadAsync(whole.buffer)).files)).toHaveLength(FIVE_HUNDRED_PAGES);
    },
    LIMIT_DOCUMENT_TIMEOUT_MS
  );

  oracleTest(
    'the first page of a longer document is accepted, since only it is drawn',
    ['pdftoppm', 'pdfinfo'],
    async () => {
      const result = await executeWorkerConversion(await pdfWithPages(FIVE_HUNDRED_AND_ONE_PAGES), 'pdf', 'png', { multiPageOutput: 'first' }, 'long.pdf');
      expect(result.mimeType).toBe('image/png');
    },
    ENGINE_TEST_TIMEOUT_MS
  );

  for (const target of ['svg', 'tiff', 'webp', 'eps']) {
    oracleTest(
      `${target}: ${FIVE_HUNDRED_AND_ONE_PAGES} selected pages are refused with the typed 413`,
      ['pdftoppm', 'pdftocairo', 'pdftops', 'pdfinfo'],
      async () => {
        const longer = await pdfWithPages(FIVE_HUNDRED_AND_ONE_PAGES);
        const error = await captureError(() => convertPdfPagesWithNativeTools(longer, target, { throwOnUnavailable: true }, 'long.pdf'));
        expect(error).toMatchObject({ name: 'PayloadLimitError', status: HTTP_PAYLOAD_TOO_LARGE });
        expect(error.message).toContain(`at most ${FIVE_HUNDRED_PAGES}`);
      },
      ENGINE_TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    `one PostScript file of ${FIVE_HUNDRED_AND_ONE_PAGES} pages is not page images, so it is not refused`,
    ['pdftops', 'pdfinfo'],
    async () => {
      const result = await convertPdfPagesWithNativeTools(await pdfWithPages(FIVE_HUNDRED_AND_ONE_PAGES), 'ps', { throwOnUnavailable: true }, 'long.pdf');
      expect(result?.mimeType).toBe('application/postscript');
    },
    ENGINE_TEST_TIMEOUT_MS
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

  it('/api/convert refuses a specification past the longest one with the contract answer, before it reads a token', async () => {
    const response = await convertPost(form(await pdfWithPages(2), 'two.pdf', { targetFormat: 'png', options: JSON.stringify({ pages: `${'1,'.repeat(LONGEST_SPEC_CHARS)}1` }) }, key));
    expect(response.status).toBe(HTTP_BAD_REQUEST);
    expect((await response.json()).invalidParams).toEqual([{ name: 'pages', reason: `must NOT have more than ${LONGEST_SPEC_CHARS} characters` }]);
  });

  it('/api/v1/convert refuses a specification past the longest one with a 422 that names the option and the limit', async () => {
    const response = await v1ConvertPost(form(await pdfWithPages(2), 'two.pdf', { targetFormat: 'png', options: JSON.stringify({ pages: `${'1,'.repeat(LONGEST_SPEC_CHARS)}1` }) }, key));
    expect(response.status).toBe(HTTP_UNPROCESSABLE);
    expect(JSON.stringify(await response.json())).toMatch(new RegExp(`pages.*${LONGEST_SPEC_CHARS}|${LONGEST_SPEC_CHARS}.*pages`));
  });

  it('/api/v1/jobs accepts a range past 50 pages for a free account', async () => {
    const pdf = await pdfWithPages(SIXTY_PAGES);
    const request = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'sixty.pdf',
        targetFormat: 'png',
        options: { pages: `1-${SIXTY_PAGES}` },
        inputBufferBase64: pdf.toString('base64'),
        fileSize: pdf.length,
      }),
    });
    const response = await v1JobsPost(request);
    expect(response.status).toBe(HTTP_ACCEPTED);
  });
});

describe('the engine guard of a multi-page image has one value for every caller', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK).each([
    ['an anonymous caller', undefined],
    ['a free account', 'free'],
    ['an enterprise account', 'enterprise'],
  ] as const)('%s is refused a document past the guard with the same typed answer', async (_label, who) => {
    const tierKey = who === 'enterprise' ? await keyOfTier('enterprise') : key;
    const response = await convertPost(form(tiffWithPages(FIVE_HUNDRED_AND_ONE_PAGES), 'many.tif', { targetFormat: 'png', options: JSON.stringify({}) }, who && tierKey));
    expect(response.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(JSON.stringify(await response.json())).toContain(`at most ${FIVE_HUNDRED_PAGES}`);
  }, LIMIT_DOCUMENT_TIMEOUT_MS);
});
