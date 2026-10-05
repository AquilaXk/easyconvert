import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The edge limiter keeps module-level buckets; every test imports a fresh copy so bucket state
// (and the cached client-IP config) never leaks between cases.
type MiddlewareFn = (request: NextRequest) => Response;

// Hand-written goldens for the edge token bucket (60 burst tokens, frozen clock => no refill).
const EDGE_BURST_CAPACITY = 60;
const REQUESTS_PER_PROBE = 120;
const FROZEN_NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

async function loadMiddleware(): Promise<MiddlewareFn> {
  vi.resetModules();
  const mod = await import('../src/middleware');
  return mod.middleware as MiddlewareFn;
}

function apiRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/health', { method: 'GET', headers });
}

function countStatuses(responses: Response[]): { allowed: number; limited: number } {
  let limited = 0;
  for (const res of responses) {
    if (res.status === 429) limited += 1;
  }
  return { allowed: responses.length - limited, limited };
}

describe('edge middleware client-IP attribution (rate-limit bypass regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_MS);
    vi.stubEnv('TRUSTED_PROXIES', '');
    vi.stubEnv('TRUSTED_CDN', '');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('baseline: one client sending identical requests is limited after the burst', async () => {
    const middleware = await loadMiddleware();
    const responses: Response[] = [];
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      responses.push(middleware(apiRequest({ 'x-forwarded-for': '198.51.100.7' })));
    }
    const { allowed, limited } = countStatuses(responses);
    expect(allowed).toBe(EDGE_BURST_CAPACITY);
    expect(limited).toBe(REQUESTS_PER_PROBE - EDGE_BURST_CAPACITY);
  });

  it('a different spoofed X-Forwarded-For per request does not evade the limiter (no proxy configured)', async () => {
    const middleware = await loadMiddleware();
    const responses: Response[] = [];
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      responses.push(middleware(apiRequest({ 'x-forwarded-for': `203.0.113.${i + 1}` })));
    }
    const { allowed, limited } = countStatuses(responses);
    expect(allowed).toBe(EDGE_BURST_CAPACITY);
    expect(limited).toBe(REQUESTS_PER_PROBE - EDGE_BURST_CAPACITY);

    const rejected = responses.find((r) => r.status === 429) as Response;
    expect(rejected.headers.get('content-type')).toBe('application/problem+json');
    expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('rotating CF-Connecting-IP / X-Real-IP / Forwarded values do not evade the limiter', async () => {
    const middleware = await loadMiddleware();
    const responses: Response[] = [];
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      responses.push(
        middleware(
          apiRequest({
            'cf-connecting-ip': `198.51.100.${(i % 250) + 1}`,
            'x-real-ip': `192.0.2.${(i % 250) + 1}`,
            forwarded: `for=203.0.113.${(i % 250) + 1}`,
          })
        )
      );
    }
    expect(countStatuses(responses).limited).toBe(REQUESTS_PER_PROBE - EDGE_BURST_CAPACITY);
  });

  it('behind a configured proxy, a spoofed leftmost hop is ignored and the proxy-observed client is limited', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const middleware = await loadMiddleware();
    const responses: Response[] = [];
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      // The trusted proxy appends the address it actually saw (198.51.100.7) on the right.
      responses.push(middleware(apiRequest({ 'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.7` })));
    }
    expect(countStatuses(responses).limited).toBe(REQUESTS_PER_PROBE - EDGE_BURST_CAPACITY);
  });

  it('behind a configured proxy, distinct real clients keep independent buckets', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const middleware = await loadMiddleware();
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      middleware(apiRequest({ 'x-forwarded-for': '198.51.100.7' }));
    }
    expect(middleware(apiRequest({ 'x-forwarded-for': '198.51.100.7' })).status).toBe(429);
    expect(middleware(apiRequest({ 'x-forwarded-for': '198.51.100.8' })).status).toBe(200);
  });

  it('honours CF-Connecting-IP only when TRUSTED_CDN=cloudflare and the nearest hop is a Cloudflare edge', async () => {
    vi.stubEnv('TRUSTED_CDN', 'cloudflare');
    const middleware = await loadMiddleware();
    // 173.245.48.5 is inside the published Cloudflare range 173.245.48.0/20.
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      middleware(
        apiRequest({ 'x-forwarded-for': '198.51.100.7, 173.245.48.5', 'cf-connecting-ip': '198.51.100.7' })
      );
    }
    expect(
      middleware(apiRequest({ 'x-forwarded-for': '198.51.100.7, 173.245.48.5', 'cf-connecting-ip': '198.51.100.7' }))
        .status
    ).toBe(429);
    expect(
      middleware(apiRequest({ 'x-forwarded-for': '198.51.100.9, 173.245.48.5', 'cf-connecting-ip': '198.51.100.9' }))
        .status
    ).toBe(200);

    // Nearest hop is NOT a Cloudflare edge: the forged header is ignored, rightmost XFF entry wins.
    const forged: Response[] = [];
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      forged.push(
        middleware(apiRequest({ 'x-forwarded-for': '203.0.113.200', 'cf-connecting-ip': `192.0.2.${(i % 250) + 1}` }))
      );
    }
    expect(countStatuses(forged).limited).toBe(REQUESTS_PER_PROBE - EDGE_BURST_CAPACITY);
  });

  it('rotating addresses inside one IPv6 /64 share a bucket; another /64 keeps its own', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const middleware = await loadMiddleware();
    const responses: Response[] = [];
    for (let i = 0; i < REQUESTS_PER_PROBE; i++) {
      responses.push(middleware(apiRequest({ 'x-forwarded-for': `2001:db8:1:2:${i.toString(16)}::${i + 1}` })));
    }
    expect(countStatuses(responses).limited).toBe(REQUESTS_PER_PROBE - EDGE_BURST_CAPACITY);
    expect(middleware(apiRequest({ 'x-forwarded-for': '2001:db8:1:3::1' })).status).toBe(200);
  });

  it('rejects a malformed forwarding chain from a declared proxy with a 400 problem document', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const middleware = await loadMiddleware();
    const res = middleware(apiRequest({ 'x-forwarded-for': '203.0.113.1, not-an-ip' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    expect(body.status).toBe(400);
    expect(body.instance).toBe('/api/health');
  });

  it('fails closed with a 500 problem document when TRUSTED_PROXIES is misconfigured', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/33');
    const middleware = await loadMiddleware();
    const res = middleware(apiRequest({ 'x-forwarded-for': '198.51.100.7' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });
});
