import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SMALL_REQUEST_BODY_MAX_BYTES, partBodyVerdict, requestBodyVerdict } from '../src/lib/api/request-body-limit';
import { SINGLE_REQUEST_BODY_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';

type MiddlewareFn = (request: NextRequest) => Response | Promise<Response>;

/** The check of a request to `pathAndQuery` that declares `length`, or none when null. */
function verdict(pathAndQuery: string, length: string | null) {
  return requestBodyVerdict(new URL(`http://localhost:3000${pathAndQuery}`), new Headers(length === null ? {} : { 'content-length': length }));
}

function lengthHeaders(length: string | null): Headers {
  return new Headers(length === null ? {} : { 'content-length': length });
}

const CHUNKED = new Headers({ 'transfer-encoding': 'chunked' });
const NO_LENGTH = new Headers();
const LENGTH_REQUIRED = {
  countUpTo: 0,
  status: 411,
  detail: 'A request that carries a file must declare its Content-Length; send the body with its length instead of in chunks.',
};

/** A request whose body of `bytes` bytes comes without a declared length, chunked unless `framing` says otherwise. */
function chunked(pathAndQuery: string, bytes: number, framing: Record<string, string> = { 'transfer-encoding': 'chunked' }): NextRequest {
  const chunk = new Uint8Array(64 * 1024);
  let left = bytes;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(left, chunk.length);
      left -= size;
      controller.enqueue(chunk.subarray(0, size));
    },
  });
  return new NextRequest(`http://localhost:3000${pathAndQuery}`, {
    method: 'POST',
    headers: { ...framing, 'x-forwarded-for': '203.0.113.91' },
    body,
    duplex: 'half',
  } as never);
}

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
    expect(verdict('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(verdict('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
    expect(verdict('/api/queue/jobs', String(SINGLE_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(verdict('/api/queue/jobs', String(SINGLE_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
  });

  it('counts the sub-paths of an upload route as that route, and a look-alike prefix as another route', () => {
    expect(verdict('/api/v1/uploads/direct/part', String(SINGLE_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(verdict('/api/v1/uploads/tus/abc', String(SINGLE_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(verdict('/api/convertx', String(SMALL_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
  });

  it.each(['abc', '12x', '-1', '1.5', '', ' ', '99999999999999999999'])('refuses the declared length %j as malformed', (length) => {
    expect(verdict('/api/convert', length)).toEqual({ status: 400, detail: 'The Content-Length header is not a whole number of bytes.' });
    expect(partBodyVerdict(lengthHeaders(length))?.status).toBe(400);
  });

  it('leaves a part without a declared length to the middleware, which counts it', () => {
    expect(partBodyVerdict(lengthHeaders(null))).toBeNull();
  });

  it('takes no byte of a file sent without a length, chunked or not, which the framework would cut short at one request without an error', () => {
    const target = (pathAndQuery: string) => new URL(`http://localhost:3000${pathAndQuery}`);
    for (const headers of [CHUNKED, NO_LENGTH]) {
      expect(requestBodyVerdict(target('/api/queue/jobs'), headers)).toEqual(LENGTH_REQUIRED);
      expect(requestBodyVerdict(target('/api/convert'), headers)).toEqual(LENGTH_REQUIRED);
      expect(requestBodyVerdict(target('/api/storage/multipart?action=chunk&uploadId=u&partNumber=1'), headers)).toEqual(LENGTH_REQUIRED);
    }
  });

  it('counts any other body sent without a length against the small limit', () => {
    const target = (pathAndQuery: string) => new URL(`http://localhost:3000${pathAndQuery}`);
    const counted = { countUpTo: SMALL_REQUEST_BODY_MAX_BYTES, status: 413, detail: 'This request carries more than the 1 MiB this route takes.' };
    expect(requestBodyVerdict(target('/api/auth/login'), CHUNKED)).toEqual(counted);
    expect(requestBodyVerdict(target('/api/auth/login'), NO_LENGTH)).toEqual(counted);
    expect(requestBodyVerdict(target('/api/storage/multipart?action=initiate'), CHUNKED)).toMatchObject({ countUpTo: SMALL_REQUEST_BODY_MAX_BYTES });
  });

  it('gives the parts route one request only for a part; its other actions take a small JSON body', () => {
    expect(verdict('/api/storage/multipart?action=chunk&uploadId=u&partNumber=1', String(SINGLE_REQUEST_BODY_MAX_BYTES))).toBeNull();
    expect(verdict('/api/storage/multipart?action=initiate', String(SMALL_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
    expect(verdict('/api/storage/multipart', String(SMALL_REQUEST_BODY_MAX_BYTES + 1))?.status).toBe(413);
    expect(verdict('/api/storage/multipart?action=complete', String(SMALL_REQUEST_BODY_MAX_BYTES))).toBeNull();
  });

  it('gives one request to every route that reads its body whole or takes new files, and the small limit to one that starts a file from JSON', () => {
    /** The query under which a route takes its file, for a route whose other actions are JSON. */
    const fileQuery: Record<string, string> = { '/api/storage/multipart': '?action=chunk' };
    /** Routes that start a new file from a JSON body alone: a link to fetch. */
    const jsonOnly = new Set(['/api/fetch-url']);
    const apiDir = path.join(__dirname, '../src/app/api');
    const routes = fs
      .readdirSync(apiDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('route.ts') && /\b(withinSingleRequest|admittingNewFiles)\(/.test(fs.readFileSync(path.join(apiDir, file), 'utf8')))
      .map((file) => `/api/${path.dirname(file).split(path.sep).filter((segment) => !segment.startsWith('[')).join('/')}`);
    expect(routes.length).toBeGreaterThanOrEqual(10);
    for (const route of routes) {
      const single = verdict(`${route}${fileQuery[route] ?? ''}`, String(SINGLE_REQUEST_BODY_MAX_BYTES));
      if (jsonOnly.has(route)) expect(single?.status, route).toBe(413);
      else expect(single, route).toBeNull();
    }
  });

  it('holds a part to the largest part', () => {
    expect(partBodyVerdict(lengthHeaders(String(UPLOAD_PART_MAX_BYTES)))).toBeNull();
    expect(partBodyVerdict(lengthHeaders(String(UPLOAD_PART_MAX_BYTES + 1)))).toEqual({
      status: 413,
      detail: 'This part carries 67,108,865 bytes, over the largest part of 64 MiB.',
    });
  });

  it('names the parts flow of the web application to its routes and the public flow to the public routes', () => {
    const over = String(SINGLE_REQUEST_BODY_MAX_BYTES + 1);
    expect(verdict('/api/convert', over)).toEqual({
      status: 413,
      detail:
        'This request carries 68,157,441 bytes, over the 64 MiB one request may carry. Send a larger file in parts of at most 64 MiB: ' +
        'open an upload with POST /api/storage/multipart, send the parts, then start the conversion with POST /api/queue/jobs on the stored file.',
    });
    expect(verdict('/api/v1/convert', over)).toEqual({
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

    const over = await middleware(declaring('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES + 1)));
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ status: 413, title: 'Payload Too Large', instance: '/api/auth/login' });

    const within = await middleware(declaring('/api/auth/login', String(SMALL_REQUEST_BODY_MAX_BYTES)));
    expect(within.headers.get('x-middleware-next')).toBe('1');
  });

  it('answers 413 for an upload route past one request and 400 for a malformed length', async () => {
    const middleware = await loadMiddleware();

    const over = await middleware(declaring('/api/storage/multipart?action=chunk', String(SINGLE_REQUEST_BODY_MAX_BYTES + 1)));
    expect(over.status).toBe(413);
    expect((await over.json()).detail).toContain('in parts of at most 64 MiB');

    const malformed = await middleware(declaring('/api/queue/jobs', 'abc'));
    expect(malformed.status).toBe(400);

    const part = await middleware(declaring('/api/storage/multipart?action=chunk', String(SINGLE_REQUEST_BODY_MAX_BYTES)));
    expect(part.headers.get('x-middleware-next')).toBe('1');
  });

  it('answers 411 for a file sent without a length', async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(chunked('/api/queue/jobs', 1024));
    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ status: 411, title: 'Length Required', instance: '/api/queue/jobs' });
  });

  it('answers 411 for a file whose body names neither a length nor chunks, as HTTP/2 frames it', async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(chunked('/api/queue/jobs', 1024, {}));
    expect(res.status).toBe(411);
  });

  it('lets a request to a file route through that has no body and no length', async () => {
    const middleware = await loadMiddleware();
    const empty = await middleware(chunked('/api/v1/uploads', 0, {}));
    expect(empty.headers.get('x-middleware-next')).toBe('1');
    const read = await middleware(new NextRequest('http://localhost:3000/api/v1/jobs', { headers: { 'x-forwarded-for': '203.0.113.92' } }));
    expect(read.headers.get('x-middleware-next')).toBe('1');
  });

  it('counts a JSON body sent without a length, answering 413 past 1 MiB and letting one within it through', async () => {
    const middleware = await loadMiddleware();

    const over = await middleware(chunked('/api/auth/login', SMALL_REQUEST_BODY_MAX_BYTES + 1));
    expect(over.status).toBe(413);
    expect((await over.json()).detail).toBe('This request carries more than the 1 MiB this route takes.');

    const within = await middleware(chunked('/api/auth/login', SMALL_REQUEST_BODY_MAX_BYTES));
    expect(within.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('a route that takes a file whole refuses a malformed length itself', () => {
  it('answers 400 instead of reading a body whose length is not a number', async () => {
    const res = await v1ConvertPost(declaring('/api/v1/convert', '12x'));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe('The Content-Length header is not a whole number of bytes.');
  });

  it.each([
    ['/api/convert', convertPost],
    ['/api/convert/batch', batchPost],
    ['/api/v1/convert', v1ConvertPost],
  ])('%s answers 413 for a body declared past one request before it authenticates or reads the form', async (route, post) => {
    const res = await post(declaring(route, String(SINGLE_REQUEST_BODY_MAX_BYTES + 1)));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: 413, maxRequestBytes: SINGLE_REQUEST_BODY_MAX_BYTES, instance: route });
  });
});
