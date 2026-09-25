import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getFormats } from '../src/app/api/formats/route';
import { GET as getHealth } from '../src/app/api/health/route';
import { POST as fetchUrl } from '../src/app/api/fetch-url/route';

describe('API Route Logic Tests', () => {
  it('GET /api/formats returns valid response structure', async () => {
    const res = await getFormats();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.count).toBeGreaterThan(15);
    expect(Array.isArray(data.categories)).toBe(true);
    expect(Array.isArray(data.formats)).toBe(true);
  });

  it('GET /api/health returns healthy service status', async () => {
    const res = await getHealth();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.service).toBe('EasyConvert');
    expect(data.features.imageProcessing).toBe(true);
    expect(data.features.documentProcessing).toBe(true);
    expect(data.features.dataTransformation).toBe(true);
    expect(data.features.archiveBundling).toBe(true);
  });

  it('POST /api/fetch-url blocks SSRF attempts to private hosts and localhost', async () => {
    const req = new NextRequest('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://127.0.0.1:8080/secret' }),
    });

    const res = await fetchUrl(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/internal|private/i);
  });

  it('POST /api/fetch-url rejects invalid URLs', async () => {
    const req = new NextRequest('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'not-a-valid-url' }),
    });

    const res = await fetchUrl(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});
