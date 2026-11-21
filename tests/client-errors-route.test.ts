import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as route from '../src/app/api/client-errors/route';
import { CLIENT_ERROR_MAX_PER_IP, resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { CLIENT_ERROR_MAX_BODY_BYTES } from '../src/lib/client-errors/report';

/** POST /api/client-errors takes a crash report of the converter UI from this site's own pages and writes one server log line for it (entry 384). */

const URL_OF_ROUTE = 'https://convert.example.test/api/client-errors';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REPORT = {
  kind: 'error',
  name: 'TypeError',
  message: 'x is not a function',
  stack: 'TypeError: x is not a function\n    at run (https://convert.example.test/_next/static/chunks/app/page-1a2.js:1:2)',
  path: '/ko/pdf-to-jpg',
  release: '0123456789abcdef0123456789abcdef01234567',
};
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'user-agent': CHROME_UA, 'content-type': 'application/json', host: 'convert.example.test' };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetLoginRateLimiterStore();
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}, client = '198.51.100.7'): Promise<Response> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return route.POST(new NextRequest(URL_OF_ROUTE, { method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': client, ...headers }, body: text }));
}

const logged = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

describe('the route', () => {
  it('takes POST only', () => {
    expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name))).toEqual(['POST']);
  });

  it('answers 204 with no body, and writes one log line of the report', async () => {
    const res = await post(REPORT);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatch(/^\[client-error\] \{/);
    expect(JSON.parse(logged()[0].replace('[client-error] ', ''))).toEqual({
      kind: 'error',
      name: 'TypeError',
      message: 'x is not a function',
      frames: ['run /_next/static/chunks/app/page-1a2.js:1:2'],
      path: '/ko/pdf-to-jpg',
      release: REPORT.release,
      browser: 'chrome',
    });
  });

  it('writes no address, no cookie, no user agent and no header of the request', async () => {
    await post(REPORT, { cookie: 'session=abc.def', authorization: 'Bearer secret-credential-value' }, '198.51.100.7');
    expect(logged()).toHaveLength(1);
    const line = logged()[0];
    expect(Object.keys(JSON.parse(line.replace('[client-error] ', ''))).sort()).toEqual(['browser', 'frames', 'kind', 'message', 'name', 'path', 'release']);
    expect(line).not.toContain('198.51.100.7');
    expect(line).not.toContain('abc.def');
    expect(line).not.toContain('secret-credential-value');
    expect(line).not.toContain('Macintosh');
  });
});

describe('who may send', () => {
  it.each([
    ['another site', { 'sec-fetch-site': 'cross-site' }],
    ['a sibling host', { 'sec-fetch-site': 'same-site' }],
    ['the address bar', { 'sec-fetch-site': 'none' }],
  ])('refuses a request from %s', async (_label, headers) => {
    const res = await post(REPORT, headers);
    expect(res.status).toBe(403);
    expect(logged()).toEqual([]);
  });

  it('refuses a request that says nothing of its origin', async () => {
    const res = await post(REPORT, { 'sec-fetch-site': '' });
    expect(res.status).toBe(403);
  });

  it('takes a browser that sends an Origin and no Fetch Metadata only from this host', async () => {
    expect((await post(REPORT, { 'sec-fetch-site': '', origin: 'https://convert.example.test' })).status).toBe(204);
    expect((await post(REPORT, { 'sec-fetch-site': '', origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(REPORT, { 'sec-fetch-site': '', origin: 'null' })).status).toBe(403);
  });
});

describe('what it reads', () => {
  it('refuses a body over the cap by its declared length, without reading it', async () => {
    const res = await post(REPORT, { 'content-length': String(CLIENT_ERROR_MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(logged()).toEqual([]);
  });

  it('refuses a body over the cap that declares no length', async () => {
    const filler = 'x'.repeat(CLIENT_ERROR_MAX_BODY_BYTES);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...REPORT, message: filler })));
        controller.close();
      },
    });
    const res = await route.POST(
      new NextRequest(URL_OF_ROUTE, { method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': '198.51.100.7' }, body, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1])
    );
    expect(res.status).toBe(413);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an empty body', ''],
    ['an array', '[]'],
    ['a report of an unknown kind', JSON.stringify({ ...REPORT, kind: 'log' })],
    ['a report with no message', JSON.stringify({ kind: 'error', name: 'Error', path: '/' })],
  ])('refuses %s with 400, and never repeats it', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const answer = await res.text();
    if (body) expect(answer).not.toContain(body);
    expect(logged()).toEqual([]);
  });

  it('cuts what a report holds before it logs it: the query string, an address, a token and a file name never reach the line', async () => {
    const res = await post({
      ...REPORT,
      message: 'Cannot decode holiday_2025.heic for jane@example.com via https://convert.example.test/api/x?token=zq81x',
      path: '/ko/pdf-to-jpg?email=jane@example.com&token=zq81x#top',
      email: 'jane@example.com',
      localStorage: '{"token":"zq81x"}',
    });
    expect(res.status).toBe(204);
    const line = logged().join('\n');
    expect(line).not.toMatch(/holiday|jane|token|zq81x|localStorage|example\.com/);
    expect(line).toContain('"path":"/ko/pdf-to-jpg"');
  });
});

describe('the rate limit', () => {
  it('refuses a client past its share with 429 and Retry-After, and keeps counting each client on its own', async () => {
    for (let sent = 0; sent < CLIENT_ERROR_MAX_PER_IP; sent++) expect((await post(REPORT)).status).toBe(204);
    const refused = await post(REPORT);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await refused.text()).not.toContain('is not a function');
    expect(logged()).toHaveLength(CLIENT_ERROR_MAX_PER_IP);
    expect((await post(REPORT, {}, '198.51.100.8')).status).toBe(204);
  });

  it('counts a report that is refused as invalid, so a flood of bad bodies is limited too', async () => {
    for (let sent = 0; sent < CLIENT_ERROR_MAX_PER_IP; sent++) expect((await post('nope')).status).toBe(400);
    expect((await post(REPORT)).status).toBe(429);
  });
});
