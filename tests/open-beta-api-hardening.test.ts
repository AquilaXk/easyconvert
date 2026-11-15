import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants.js';
import JSZip from 'jszip';
import loadNextConfig from '../next.config.mjs';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

vi.mock('@/lib/security/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/ssrf')>();
  return { ...actual, validateUrlForSsrf: vi.fn(actual.validateUrlForSsrf) };
});

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { fetch as undiciFetch } from 'undici';
import { validateUrlForSsrf } from '@/lib/security/ssrf';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { POST as fetchUrlPost } from '../src/app/api/fetch-url/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as inspectArchivePost } from '../src/app/api/v1/archives/inspect/route';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

const BASE_URL = 'http://localhost:3000';
const VISITOR = { 'x-forwarded-for': '203.0.113.77' };
const CSV = 'name,score\nAlice,100\nBob,95\n';

async function createPaidCaller(): Promise<{ userId: string; headers: Record<string, string> }> {
  const email = `openbeta_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@hardening.test`;
  const user = userStore.sanitizeUser(
    await userStore.createUser({ email, name: 'OpenBeta', tier: 'paid', emailVerified: true })
  );
  return {
    userId: user.id,
    headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
  };
}

function truncatedStream(initialChunk: Uint8Array, errorMessage: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(initialChunk);
        return;
      }
      controller.error(new Error(errorMessage));
    },
  });
}

describe('Open Beta API boundary error classification (400 / 502 / 504 instead of 500)', () => {
  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    redisKeyStore.resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('POST /api/fetch-url upstream failures', () => {
    it('maps upstream TCP/DNS fetch failures to 502 fetch_failed instead of 500', async () => {
      vi.mocked(validateUrlForSsrf).mockResolvedValueOnce(true);
      const connErr = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), { code: 'ECONNREFUSED' }),
      });
      vi.mocked(undiciFetch).mockRejectedValueOnce(connErr as never);

      const res = await fetchUrlPost(
        new NextRequest(`${BASE_URL}/api/fetch-url`, {
          method: 'POST',
          headers: { ...VISITOR, 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://93.184.216.34/report.pdf' }),
        })
      );

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, code: 'fetch_failed' });
    });

    it('maps per-hop 12 s header timeout to 504 fetch_timeout instead of 500', async () => {
      vi.useFakeTimers();
      vi.mocked(validateUrlForSsrf).mockResolvedValueOnce(true);
      vi.mocked(undiciFetch).mockImplementationOnce(((_url: unknown, init?: { signal?: AbortSignal | null }) => {
        const sig = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          sig?.addEventListener(
            'abort',
            () => {
              const abortErr = new Error('This operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            },
            { once: true }
          );
        });
      }) as never);

      const pending = fetchUrlPost(
        new NextRequest(`${BASE_URL}/api/fetch-url`, {
          method: 'POST',
          headers: { ...VISITOR, 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://93.184.216.34/slow-headers.pdf' }),
        })
      );

      await vi.advanceTimersByTimeAsync(12_500);
      const res = await pending;

      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, code: 'fetch_timeout' });
    });

    it('maps upstream mid-body stream disconnects to 502 fetch_failed instead of 500', async () => {
      vi.mocked(validateUrlForSsrf).mockResolvedValueOnce(true);
      const brokenBody = truncatedStream(new TextEncoder().encode('%PDF-1.7\n'), 'Socket closed unexpectedly');
      vi.mocked(undiciFetch).mockResolvedValueOnce(
        new Response(brokenBody, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }) as never
      );

      const res = await fetchUrlPost(
        new NextRequest(`${BASE_URL}/api/fetch-url`, {
          method: 'POST',
          headers: { ...VISITOR, 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://93.184.216.34/cut-off.pdf' }),
        })
      );

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, code: 'fetch_failed' });
    });
  });

  describe('POST /api/convert/batch pre-flight target validation', () => {
    it.each(['{"other.csv":"mp3"}', '{"other.csv":"bogus"}', '{"other.csv":""}'])(
      'rejects unsupported explicit per-file target (%s) with 400 unsupported_pair before converting earlier files or charging quota',
      async (targetFormats) => {
        const { userId, headers } = await createPaidCaller();
        const before = await redisKeyStore.getQuotaUsage(userId);

        const form = new FormData();
        form.append('files', new File([CSV], 'first.csv', { type: 'text/csv' }));
        form.append('files', new File([CSV], 'other.csv', { type: 'text/csv' }));
        form.append('targetFormats', targetFormats);

        const res = await batchPost(
          new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', headers, body: form })
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('unsupported_pair');
        expect(dispatchConversion).not.toHaveBeenCalled();

        const after = await redisKeyStore.getQuotaUsage(userId);
        expect(after.usedToday).toBe(before.usedToday);
      }
    );

    it('rejects an unsupported default target with 400 unsupported_pair when no file can convert to it', async () => {
      const { userId, headers } = await createPaidCaller();
      const before = await redisKeyStore.getQuotaUsage(userId);

      const form = new FormData();
      form.append('files', new File([CSV], 'scores.csv', { type: 'text/csv' }));
      form.append('targetFormats', '{"default":"mp3"}');

      const res = await batchPost(
        new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', headers, body: form })
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('unsupported_pair');
      expect(dispatchConversion).not.toHaveBeenCalled();

      const after = await redisKeyStore.getQuotaUsage(userId);
      expect(after.usedToday).toBe(before.usedToday);
    });

    it('skips incompatible files on a mixed default batch and converts the compatible ones', async () => {
      const { headers } = await createPaidCaller();
      const form = new FormData();
      form.append('files', new File([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00')], 'clip.mp3', { type: 'audio/mpeg' }));
      form.append('files', new File([CSV], 'scores.csv', { type: 'text/csv' }));
      form.append('targetFormats', '{"default":"xlsx"}');

      const res = await batchPost(
        new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', headers, body: form })
      );

      expect(res.status).toBe(200);
      const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
      expect(Object.keys(zip.files)).toEqual(['scores.xlsx']);
    });
  });

  describe('truncated client request streams return 400 instead of 500', () => {
    it('returns 400 when a multipart stream errors mid-body on /api/convert', async () => {
      const { headers } = await createPaidCaller();
      const chunk = new TextEncoder().encode('--boundary123\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\na,b\n');
      const req = new NextRequest(`${BASE_URL}/api/convert`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'multipart/form-data; boundary=boundary123',
          'content-length': String(chunk.byteLength + 64),
        },
        body: truncatedStream(chunk, 'Premature close'),
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]);

      const res = await convertPost(req);
      expect(res.status).toBe(400);
    });

    it('returns 400 when a multipart stream errors mid-body on /api/v1/archives/inspect', async () => {
      const { headers } = await createPaidCaller();
      const chunk = new TextEncoder().encode('--boundary123\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n\r\nPK');
      const req = new NextRequest(`${BASE_URL}/api/v1/archives/inspect`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'multipart/form-data; boundary=boundary123',
          'content-length': String(chunk.byteLength + 64),
        },
        body: truncatedStream(chunk, 'Premature close'),
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]);

      const res = await inspectArchivePost(req);
      expect(res.status).toBe(400);
    });

    it('returns 400 when a raw binary stream errors mid-body on /api/v1/archives/inspect', async () => {
      const { headers } = await createPaidCaller();
      const chunk = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const req = new NextRequest(`${BASE_URL}/api/v1/archives/inspect`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'content-length': '128',
        },
        body: truncatedStream(chunk, 'aborted'),
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]);

      const res = await inspectArchivePost(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.status).toBe(400);
    });
  });

  describe('page response security headers in next.config.mjs', () => {
    it.each([PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER])(
      'configures CSP, X-Frame-Options, Referrer-Policy and X-Content-Type-Options on page routes in phase %s without duplicating nosniff on /api/* or /_assets/*',
      async (phase) => {
        const cfg = await loadNextConfig(phase);
        const rules = await cfg.headers?.();
        expect(rules).toBeDefined();
        expect(rules).toHaveLength(1);
        const [rule] = rules!;
        expect(rule.source).toBe('/((?!api/|_assets/).*)');

        const headerMap = new Map(rule.headers.map((h: { key: string; value: string }) => [h.key, h.value]));
        expect(headerMap.get('X-Content-Type-Options')).toBe('nosniff');
        expect(headerMap.get('X-Frame-Options')).toBe('SAMEORIGIN');
        expect(headerMap.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');

        const csp = headerMap.get('Content-Security-Policy') ?? '';
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("frame-ancestors 'self'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain('https://cdn.paddle.com');
        expect(csp).toContain('https://*.paddle.com');
        expect(csp).not.toContain("'unsafe-eval'");
      }
    );

    it('permits unsafe-eval and HMR websocket connections only in PHASE_DEVELOPMENT_SERVER', async () => {
      const cfg = await loadNextConfig(PHASE_DEVELOPMENT_SERVER);
      const rules = await cfg.headers?.();
      const [rule] = rules!;
      const headerMap = new Map(rule.headers.map((h: { key: string; value: string }) => [h.key, h.value]));
      const csp = headerMap.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("'unsafe-eval'");
      expect(csp).toContain('ws: wss:');
    });
  });
});
