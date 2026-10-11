import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import {
  CONVERSION_WARNINGS_HEADER,
  MAX_CONVERSION_WARNINGS,
  MAX_CONVERSION_WARNING_CHARS,
  conversionWarningsFields,
  conversionWarningsHeaders,
} from '../src/lib/api/conversion-warnings';
import { overrideImageFetchEnvironment } from '../src/lib/conversions/html-image-fetch';
import { withMissingBinary } from './helpers/native-tools';

/**
 * A conversion that leaves part of the document out says so on every surface that reports its result: the v1 convert
 * JSON and headers, the internal convert headers, the job view and its result, and the OpenAPI document. The page
 * below has two images that cannot be loaded (a relative reference, and a host that does not resolve: no test reaches a
 * real network) and one that is embedded.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const PAGE = '<html><body><p>Quarterly summary text.</p><img src="Images/EIC012-1.GIF"><img src="https://example.com/logo.png"></body></html>';
const EXPECTED_WARNINGS = [
  'Left out the image "Images/EIC012-1.GIF": only absolute http and https images are loaded.',
  'Left out the image "https://example.com/logo.png": the host could not be resolved.',
];

let secretKey: string;
let userId: string;
let restoreFetchEnvironment: (() => void) | undefined;

afterEach(() => {
  restoreFetchEnvironment?.();
});

beforeEach(async () => {
  restoreFetchEnvironment = overrideImageFetchEnvironment({
    resolve: async () => {
      throw new Error('offline');
    },
  });
  const user = await userStore.createUser({
    name: 'Warnings Tester',
    email: `warnings_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  userId = user.id;
  const key = await redisKeyStore.generateApiKey(user.id, 'Warnings Key', { scopes: ['convert:write', 'convert:read'] });
  secretKey = key.secretKey;
});

function v1Request(page: string, headers: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append('file', new Blob([page], { type: 'text/html' }), 'report.html');
  form.append('targetFormat', 'pdf');
  return new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers: { Authorization: `Bearer ${secretKey}`, ...headers }, body: form });
}

describe('POST /api/v1/convert reports conversion warnings', () => {
  it('lists each omitted image in the JSON body', async () => {
    const res = await withMissingBinary('SOFFICE_PATH', () => v1ConvertPost(v1Request(PAGE)));
    expect(res.status).toBe(HTTP_OK);
    expect((await res.json()).warnings).toEqual(EXPECTED_WARNINGS);
  });

  it('sends them percent-encoded in a header on a raw response', async () => {
    const res = await withMissingBinary('SOFFICE_PATH', () => v1ConvertPost(v1Request(PAGE, { Accept: 'application/octet-stream' })));
    expect(res.status).toBe(HTTP_OK);
    const header = res.headers.get(CONVERSION_WARNINGS_HEADER) ?? '';
    expect(header.split(',').map(decodeURIComponent)).toEqual(EXPECTED_WARNINGS);
  });

  it('sends no warnings for a page without external images', async () => {
    const res = await withMissingBinary('SOFFICE_PATH', () => v1ConvertPost(v1Request('<html><body><p>Plain page.</p></body></html>')));
    expect(await res.json()).not.toHaveProperty('warnings');
  });
});

describe('POST /api/convert reports conversion warnings', () => {
  it('sends the header on the zero-retention response', async () => {
    const form = new FormData();
    form.append('file', new File([PAGE], 'report.html', { type: 'text/html' }));
    form.append('targetFormat', 'pdf');
    const res = await withMissingBinary('SOFFICE_PATH', () => convertRoute(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form })));
    expect(res.status).toBe(HTTP_OK);
    expect((res.headers.get(CONVERSION_WARNINGS_HEADER) ?? '').split(',').map(decodeURIComponent)).toEqual(EXPECTED_WARNINGS);
  });
});

describe('GET /api/v1/jobs/{id} reports conversion warnings', () => {
  it('carries the list in the job view and in its result', async () => {
    const worker = new Worker(conversionQueue, processConversionJob, { concurrency: 1 });
    const done = new Promise<void>((resolve) => {
      worker.on('completed', () => resolve());
      worker.on('failed', () => resolve());
    });
    const page = Buffer.from(PAGE, 'utf-8');
    const job = await withMissingBinary('SOFFICE_PATH', async () => {
      const added = await conversionQueue.add('convert', {
        jobId: '',
        originalFilename: 'report.html',
        sourceFormat: 'html',
        targetFormat: 'pdf',
        fileSize: page.length,
        options: {},
        inputBufferBase64: page.toString('base64'),
        userId,
      });
      await done;
      return added;
    });
    await worker.close();
    const res = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers: { Authorization: `Bearer ${secretKey}` } }), {
      params: Promise.resolve({ id: job.id }),
    });
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(body.warnings).toEqual(EXPECTED_WARNINGS);
    expect(body.result.warnings).toEqual(EXPECTED_WARNINGS);
  });
});

describe('conversionWarningsFields', () => {
  it('reads the list from the result metadata or from a stored job result', () => {
    expect(conversionWarningsFields({ metadata: { warnings: ['a'] } })).toEqual({ warnings: ['a'] });
    expect(conversionWarningsFields({ warnings: ['b'] })).toEqual({ warnings: ['b'] });
  });

  it('sends nothing for an empty or malformed value', () => {
    expect(conversionWarningsFields({})).toEqual({});
    expect(conversionWarningsFields({ metadata: { warnings: [] } })).toEqual({});
    expect(conversionWarningsFields({ metadata: { warnings: 'left out' } })).toEqual({});
    expect(conversionWarningsFields({ warnings: [1, null, {}, '  '] })).toEqual({});
  });

  it('keeps strings only, strips control characters and bounds the text and the count', () => {
    const fields = conversionWarningsFields({ warnings: [7, `a\u0000b\nc${'x'.repeat(MAX_CONVERSION_WARNING_CHARS * 2)}`, 'ok'] });
    expect(fields.warnings).toHaveLength(2);
    expect(fields.warnings?.[0].startsWith('a b c')).toBe(true);
    expect([...(fields.warnings?.[0] ?? '')]).toHaveLength(MAX_CONVERSION_WARNING_CHARS);
    expect(fields.warnings?.[1]).toBe('ok');
    const many = Array.from({ length: MAX_CONVERSION_WARNINGS + 9 }, (_, i) => `w${i}`);
    expect(conversionWarningsFields({ warnings: many }).warnings).toHaveLength(MAX_CONVERSION_WARNINGS);
  });

  it('writes a header of percent-encoded entries, printable ASCII, cut at an entry boundary', () => {
    expect(conversionWarningsHeaders({ warnings: ['Left out "é", 1'] })).toEqual({ [CONVERSION_WARNINGS_HEADER]: encodeURIComponent('Left out "é", 1') });
    expect(conversionWarningsHeaders({})).toEqual({});
    const long = Array.from({ length: MAX_CONVERSION_WARNINGS }, () => 'y'.repeat(MAX_CONVERSION_WARNING_CHARS));
    const value = conversionWarningsHeaders({ warnings: long })[CONVERSION_WARNINGS_HEADER];
    expect(value.length).toBeLessThanOrEqual(2048);
    expect(value).toMatch(/^[\x20-\x7e]+$/);
    expect(value.split(',').every((entry) => entry.length === MAX_CONVERSION_WARNING_CHARS)).toBe(true);
  });
});

describe('OpenAPI document', () => {
  it('documents warnings on the convert response, the job view, its result and the header', async () => {
    const spec = await (await getOpenApiSpec()).json();
    const response = spec.components.schemas.ConversionResponse.properties.warnings;
    expect(response.type).toBe('array');
    expect(response.maxItems).toBe(MAX_CONVERSION_WARNINGS);
    expect(response.items).toMatchObject({ type: 'string', maxLength: MAX_CONVERSION_WARNING_CHARS });
    const job = spec.components.schemas.JobResource.properties;
    expect(job.warnings.type).toBe('array');
    expect(job.result.properties.warnings.type).toBe('array');
    expect(spec.paths['/api/v1/convert'].post.responses['200'].headers[CONVERSION_WARNINGS_HEADER].schema.type).toBe('string');
    expect(spec.paths['/api/convert'].post.responses['200'].headers[CONVERSION_WARNINGS_HEADER].schema.type).toBe('string');
    expect(JSON.stringify(spec.webhooks['job.completed'])).toContain('warnings');
  });
});
