import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SMALL_REQUEST_BODY_MAX_BYTES, partBodyVerdict, requestBodyVerdict } from '../src/lib/api/request-body-limit';
import { SINGLE_REQUEST_BODY_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';

type MiddlewareFn = (request: NextRequest) => Response;

async function loadMiddleware(): Promise<MiddlewareFn> {
  vi.resetModules();
  return (await import('../src/middleware')).middleware as MiddlewareFn;
}

function declaring(path: string, length: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-length': length, 'x-forwarded-for': '203.0.113.90' },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the body a route takes, by its declared length', () => {
  it('gives a route that takes no file 1 MiB and a route that takes files one request', () => {
    expect(SMALL_REQUEST_BODY_MAX_BYTES).toBe(1024 * 1024);
    expect(requestBodyVerdict('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(requestBodyVerdict('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
    expect(requestBodyVerdict('/api/queue/jobs', String(SINGLE_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(requestBodyVerdict('/api/queue/jobs', String(SINGLE_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
  });

  it('counts the sub-paths of an upload route as that route, and a look-alike prefix as another route', () => {
    expect(requestBodyVerdict('/api/v1/uploads/direct/part', String(SINGLE_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(requestBodyVerdict('/api/v1/uploads/tus/abc', String(SINGLE_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(requestBodyVerdict('/api/convertx', String(SMALL_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
  });

  it.each(['abc', '12x', '-1', '1.5', '', ' ', '99999999999999999999'])('refuses the declared length %j as malformed', (length) => {
    expect(requestBodyVerdict('/api/convert', length)).toEqual({ status: 400, detail: 'The Content-Length header is not a whole number of bytes.' });
    expect(partBodyVerdict(length)?.status).toBe(400);
  });

  it('reads a body without a declared length, which the framework bounds itself', () => {
    expect(requestBodyVerdict('/api/auth/login', null)).toBeNull();
    expect(partBodyVerdict(null)).toBeNull();
  });

  it('holds a part to the largest part', () => {
    expect(partBodyVerdict(String(UPLOAD_PART_MAX_BYTES))).toBeNull();
    expect(partBodyVerdict(String(UPLOAD_PART_MAX_BYTES + 1))).toEqual({
      status: 413,
      detail: 'This part carries 67,108,865 bytes, over the largest part of 64 MiB.',
    });
  });

  it('names the parts flow of the web application to its routes and the public flow to the public routes', () => {
    const over = String(SINGLE_REQUEST_BODY_MAX_BYTES + 1);
    expect(requestBodyVerdict('/api/convert', over)).toEqual({
      status: 413,
      detail:
        'This request carries 68,157,441 bytes, over the 64 MiB one request may carry. Send a larger file in parts of at most 64 MiB: ' +
        'open an upload with POST /api/storage/multipart, send the parts, then start the conversion with POST /api/queue/jobs on the stored file.',
    });
    expect(requestBodyVerdict('/api/v1/convert', over)).toEqual({
      status: 413,
      detail:
        'This request carries 68,157,441 bytes, over the 64 MiB one request may carry. Send a larger file in parts of at most 64 MiB: ' +
        'open an upload with POST /api/v1/uploads, send the parts, then start the conversion with POST /api/v1/jobs on the stored file.',
    });
  });
});

describe('the edge middleware refuses a body before any route buffers it', () => {
  it('answers 413 for a JSON route past 1 MiB and lets one at 1 MiB through', async () => {
    const middleware = await loadMiddleware();

    const over = middleware(declaring('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES + 1)));
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ status: 413, title: 'Payload Too Large', instance: '/api/auth/login' });

    const within = middleware(declaring('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES)));
    expect(within.headers.get('x-middleware-next')).toBe('1');
  });

  it('answers 413 for an upload route past one request and 400 for a malformed length', async () => {
    const middleware = await loadMiddleware();

    const over = middleware(declaring('/api/storage/multipart', String(SINGLE_REQUEST_BODY_MAX_BYTES + 1)));
    expect(over.status).toBe(413);
    expect((await over.json()).detail).toContain('in parts of at most 64 MiB');

    const malformed = middleware(declaring('/api/queue/jobs', 'abc'));
    expect(malformed.status).toBe(400);

    expect(middleware(declaring('/api/storage/multipart', String(SINGLE_REQUEST_BODY_MAX_BYTES))).headers.get('x-middleware-next')).toBe('1');
  });
});

describe('a route that takes a file whole refuses a malformed length itself', () => {
  it('answers 400 instead of reading a body whose length is not a number', async () => {
    const res = await v1ConvertPost(declaring('/api/v1/convert', '12x'));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe('The Content-Length header is not a whole number of bytes.');
  });
});
