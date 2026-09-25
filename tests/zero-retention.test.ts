import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';

describe('Zero-Retention & In-Memory Pipeline Tests', () => {
  it('blocks files exceeding 100MB limit with descriptive error', async () => {
    // Mock NextRequest formData returning a file with size > 100MB
    const req = {
      formData: async () => {
        const map = new Map<string, any>();
        map.set('file', {
          name: 'large_dataset.zip',
          size: 105 * 1024 * 1024,
          arrayBuffer: async () => new ArrayBuffer(0),
        });
        map.set('targetFormat', 'tar');
        return map;
      },
    } as unknown as NextRequest;

    const res = await convertRoute(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/exceeds real-time in-memory conversion limit/i);
  });

  it('verifies Zero-Data-Retention headers on successful conversion', async () => {
    const textContent = '# Zero Retention Test\n\nTesting direct memory stream.';
    const file = new File([textContent], 'test.md', { type: 'text/markdown' });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('targetFormat', 'html');

    const req = new NextRequest('http://localhost/api/convert', {
      method: 'POST',
      body: formData,
    });

    const res = await convertRoute(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Zero-Data-Retention')).toBe('true');
    expect(res.headers.get('X-Storage-Footprint')).toBe('0-bytes');
    expect(res.headers.get('Content-Type')).toBe('text/html');
  });
});
