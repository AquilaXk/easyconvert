import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { SINGLE_REQUEST_BODY_MAX_BYTES } from '../src/lib/plan-limits';

describe('Zero-Retention & In-Memory Pipeline Tests', () => {
  it('refuses a request past what one request carries before it reads the body, and names the way in parts', async () => {
    const formData = vi.fn();
    const req = {
      formData,
      headers: new Headers({ 'content-length': String(SINGLE_REQUEST_BODY_MAX_BYTES + 1) }),
    } as unknown as NextRequest;

    const res = await convertRoute(req);
    expect(res.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('POST /api/storage/multipart');
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
