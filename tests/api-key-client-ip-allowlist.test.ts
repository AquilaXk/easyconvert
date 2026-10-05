import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { userStore } from '../src/lib/auth/user-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { POST as loginHandler } from '../src/app/api/auth/login/route';

const ALLOWED_RANGE = '192.168.100.0/24';
const ALLOWED_CLIENT = '192.168.100.42';
const OUTSIDER = '203.0.113.5';

function keyedRequest(secretKey: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/v1/convert', {
    headers: { 'x-api-key': secretKey, ...headers },
  });
}

describe('API-key IP allowlists use the shared trusted-proxy client-IP resolver', () => {
  let secretKey: string;
  let userId: string;

  beforeEach(async () => {
    userStore.resetStore();
    redisKeyStore.resetStore();
    redisUserStore.resetStore();
    vi.stubEnv('TRUSTED_PROXIES', '');
    vi.stubEnv('TRUSTED_CDN', '');
    const user = await userStore.createUser({ email: 'allowlist@example.com', name: 'Allowlist User' });
    userId = user.id;
    ({ secretKey } = await redisKeyStore.generateApiKey(user.id, 'Restricted Key', {
      allowedIps: [ALLOWED_RANGE],
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a spoofed X-Forwarded-For naming an allowed address cannot pass the allowlist when no proxy is configured', async () => {
    const res = await validateApiAccess(keyedRequest(secretKey, { 'x-forwarded-for': ALLOWED_CLIENT }), 0);
    expect(res.authorized).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toContain('IP');
  });

  it('spoofed CF-Connecting-IP, X-Real-IP and Forwarded headers cannot pass the allowlist', async () => {
    const res = await validateApiAccess(
      keyedRequest(secretKey, {
        'cf-connecting-ip': ALLOWED_CLIENT,
        'x-real-ip': ALLOWED_CLIENT,
        forwarded: `for=${ALLOWED_CLIENT}`,
      }),
      0
    );
    expect(res.status).toBe(403);
  });

  it('behind a declared proxy the proxy-observed address (rightmost) decides, not the leftmost claim', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');

    const spoofed = await validateApiAccess(
      keyedRequest(secretKey, { 'x-forwarded-for': `${ALLOWED_CLIENT}, ${OUTSIDER}` }),
      0
    );
    expect(spoofed.authorized).toBe(false);
    expect(spoofed.status).toBe(403);

    const genuine = await validateApiAccess(
      keyedRequest(secretKey, { 'x-forwarded-for': `${OUTSIDER}, ${ALLOWED_CLIENT}, 10.1.2.3` }),
      0
    );
    expect(genuine.authorized).toBe(true);
    expect(genuine.user?.id).toBe(userId);
  });

  it('matches an allowlisted CIDR against an IPv4-mapped IPv6 spelling supplied by the proxy', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const res = await validateApiAccess(
      keyedRequest(secretKey, { 'x-forwarded-for': '::ffff:192.168.100.42' }),
      0
    );
    expect(res.authorized).toBe(true);
  });

  it('answers a malformed forwarding chain with HTTP 400 instead of guessing an address', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const res = await validateApiAccess(
      keyedRequest(secretKey, { 'x-forwarded-for': `${ALLOWED_CLIENT}, definitely-not-an-ip` }),
      0
    );
    expect(res.authorized).toBe(false);
    expect(res.status).toBe(400);
  });

  it('anonymous quota and burst identity follow the resolver: spoofed headers all collapse to one identity', async () => {
    const identities = new Set<string>();
    for (const claimed of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      const req = new NextRequest('http://localhost/api/convert', {
        method: 'POST',
        headers: { 'x-forwarded-for': claimed, 'cf-connecting-ip': claimed },
      });
      const res = await validateApiAccess(req, { requiredUnits: 1, allowAnonymous: true });
      expect(res.authorized).toBe(true);
      identities.add(res.user?.id ?? 'missing');
    }
    expect([...identities]).toEqual(['anon:unattributed']);
  });

  it('anonymous identity is the proxy-observed client when a proxy is declared', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const req = new NextRequest('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.1.1.1, 198.51.100.77' },
    });
    const res = await validateApiAccess(req, { requiredUnits: 1, allowAnonymous: true });
    expect(res.user?.id).toBe('anon:198.51.100.77');
  });

  it('the login route answers a malformed forwarding chain with HTTP 400', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const req = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1, nope' },
      body: JSON.stringify({ email: 'a@example.com', password: 'whatever' }),
    });
    const res = await loginHandler(req);
    expect(res.status).toBe(400);
  });
});
