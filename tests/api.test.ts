import { afterEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getFormats } from '../src/app/api/formats/route';
import { POST as fetchUrl } from '../src/app/api/fetch-url/route';
import { POST as convertRoute } from '../src/app/api/convert/route';

/** A visitor a declared proxy attributes: one no proxy attributes is refused every link import, as every upload. */
const VISITOR = { 'x-forwarded-for': '203.0.113.40' };

describe('API Route Logic Tests', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GET /api/formats returns valid response structure', async () => {
    const res = await getFormats();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.count).toBeGreaterThan(15);
    expect(Array.isArray(data.categories)).toBe(true);
    expect(Array.isArray(data.formats)).toBe(true);
  });

  it('POST /api/fetch-url blocks SSRF attempts to private hosts and localhost', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const req = new NextRequest('http://localhost/api/fetch-url', {
      method: 'POST',
      headers: VISITOR,
      body: JSON.stringify({ url: 'http://127.0.0.1:8080/secret' }),
    });

    const res = await fetchUrl(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/internal|private/i);
  });

  it('POST /api/fetch-url rejects invalid URLs', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const req = new NextRequest('http://localhost/api/fetch-url', {
      method: 'POST',
      headers: VISITOR,
      body: JSON.stringify({ url: 'not-a-valid-url' }),
    });

    const res = await fetchUrl(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('POST /api/convert answers the converted bytes and claims no retention it does not have', async () => {
    const formData = new FormData();
    formData.append('file', new File(['col1,col2\nval1,val2'], 'test.csv', { type: 'text/csv' }));
    formData.append('targetFormat', 'ods');

    const req = new NextRequest('http://localhost/api/convert', {
      method: 'POST',
      body: formData,
    });

    const res = await convertRoute(req);
    expect(res.status).toBe(200);
    expect(res.headers.has('x-zero-data-retention')).toBe(false);
    expect(res.headers.get('x-storage-footprint')).toBe('0-bytes');
    expect(res.headers.get('content-type')).toBe('application/vnd.oasis.opendocument.spreadsheet');
  });
});
