import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('@/lib/security/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/ssrf')>()),
  validateUrlForSsrf: vi.fn(async () => true),
  createSsrfSafeAgent: () => ({ close: async () => undefined }),
}));

import { fetch as undiciFetch } from 'undici';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { POST as fetchUrlRoute } from '../src/app/api/fetch-url/route';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getAnonymousDailyLimit } from '../src/lib/api-keys/key-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';

/**
 * Only a successful conversion is charged (QA decision of 2026-11-02): a refusal, a failure and a link import leave the
 * day's remaining count where it was, and the anonymous allowance is the one the copy states.
 */

const HTTP_TOO_MANY_REQUESTS = 429;
const QUOTA_EXCEEDED_PROBLEM = 'https://api.easyconvert.io/problems/quota-exceeded';
const CSV = 'name,score\nAlice,100\nBob,95\n';
/** The test configuration lifts the limit for every suite; this one counts against the real allowance. */
const DAY_ALLOWANCE = 25;
const NOT_A_PNG = 'this is plain text, not a PNG picture';

let nextClient = 1;

/** A visitor behind a declared front proxy that reports the address it saw: a fresh anonymous identity per call. */
function visitor() {
  const ip = `203.0.113.${nextClient++}`;
  return {
    headers: { 'x-forwarded-for': ip },
    remaining: async () => (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining,
    spend: async (units: number) => {
      for (let i = 0; i < units; i++) {
        const unit = await redisKeyStore.reserveQuota(anonymousUserId(ip), 1);
        await redisKeyStore.commitQuota(unit.reservationId as string);
      }
    },
  };
}

type Visitor = ReturnType<typeof visitor>;

function convertRequest(client: Visitor, fields: { name: string; content: string; target?: string; options?: string }) {
  const form = new FormData();
  form.append('file', new File([fields.content], fields.name));
  if (fields.target) form.append('targetFormat', fields.target);
  if (fields.options) form.append('options', fields.options);
  return new NextRequest('http://localhost/api/convert', { method: 'POST', headers: client.headers, body: form });
}

function batchRequest(client: Visitor, files: Array<{ name: string; content: string }>, targetFormats?: string) {
  const form = new FormData();
  for (const file of files) form.append('files', new File([file.content], file.name));
  if (targetFormats) form.append('targetFormats', targetFormats);
  return new NextRequest('http://localhost/api/convert/batch', { method: 'POST', headers: client.headers, body: form });
}

function importRequest(client: Visitor, url = 'https://files.example.com/scores.csv') {
  return new NextRequest('http://localhost/api/fetch-url', {
    method: 'POST',
    headers: { ...client.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

function remoteFile(content: string, contentType = 'text/csv') {
  vi.mocked(undiciFetch).mockResolvedValue(new Response(content, { status: 200, headers: { 'content-type': contentType } }) as never);
}

describe('what a request is charged', () => {
  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(DAY_ALLOWANCE));
    redisKeyStore.resetStore();
    vi.mocked(undiciFetch).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('the anonymous allowance', () => {
    it('is 25 conversions a day when nothing configures it', () => {
      vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '');
      expect(getAnonymousDailyLimit()).toBe(25);
      expect(ANONYMOUS_DAILY_CONVERSIONS).toBe(25);
    });

    it('names the configured limit in the refusal, not a literal', async () => {
      vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '3');
      const client = visitor();
      await client.spend(3);

      const res = await convertRoute(convertRequest(client, { name: 'scores.csv', content: CSV, target: 'json' }));

      expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
      const body = await res.json();
      expect(body.detail ?? body.error).toContain('3 conversions per day');
    });
  });

  describe('a link import', () => {
    it('is free: the file comes back and the remaining count is unchanged', async () => {
      const client = visitor();
      const before = await client.remaining();
      remoteFile(CSV);

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(200);
      expect(await client.remaining()).toBe(before);
    });

    it('followed by the conversion of the file costs exactly one conversion', async () => {
      const client = visitor();
      const before = await client.remaining();
      remoteFile(CSV);
      const imported = await fetchUrlRoute(importRequest(client));
      expect(imported.status).toBe(200);

      const converted = await convertRoute(
        convertRequest(client, { name: 'scores.csv', content: await imported.text(), target: 'json' })
      );

      expect(converted.status).toBe(200);
      expect(await client.remaining()).toBe(before - 1);
    });

    it('is free when the remote answers with an error', async () => {
      const client = visitor();
      const before = await client.remaining();
      vi.mocked(undiciFetch).mockResolvedValue(new Response('gone', { status: 404, statusText: 'Not Found' }) as never);

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(400);
      expect(await client.remaining()).toBe(before);
    });

    it('is refused up front with the quota problem when the caller has no conversion left', async () => {
      const client = visitor();
      await client.spend(await client.remaining());
      remoteFile(CSV);

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect((await res.json()).type).toBe(QUOTA_EXCEEDED_PROBLEM);
      expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
    });

    it('is still allowed with one conversion left, which it leaves for the conversion', async () => {
      const client = visitor();
      await client.spend((await client.remaining()) - 1);
      remoteFile(CSV);

      const imported = await fetchUrlRoute(importRequest(client));

      expect(imported.status).toBe(200);
      expect(await client.remaining()).toBe(1);
    });
  });

  describe('a refusal of /api/convert after the unit was reserved', () => {
    const refusals: Array<[string, { name: string; content: string; target?: string; options?: string }, number]> = [
      ['a file that is not what its extension says', { name: 'picture.png', content: NOT_A_PNG, target: 'jpg' }, 400],
      ['no target format', { name: 'scores.csv', content: CSV }, 400],
      ['an unknown source extension', { name: 'scores.zzzz', content: CSV, target: 'json' }, 400],
      ['a pair no engine converts', { name: 'scores.csv', content: CSV, target: 'mp4' }, 400],
      ['options that are not JSON', { name: 'scores.csv', content: CSV, target: 'json', options: '{not json' }, 400],
      ['options that are not an object', { name: 'scores.csv', content: CSV, target: 'json', options: '[1]' }, 400],
    ];

    it.each(refusals)('charges nothing for %s', async (_, fields, status) => {
      const client = visitor();
      const before = await client.remaining();

      const res = await convertRoute(convertRequest(client, fields));

      expect(res.status).toBe(status);
      expect(await client.remaining()).toBe(before);
    });

    it('charges one conversion for the same request when it succeeds', async () => {
      const client = visitor();
      const before = await client.remaining();

      const res = await convertRoute(convertRequest(client, { name: 'scores.csv', content: CSV, target: 'json' }));

      expect(res.status).toBe(200);
      expect(await client.remaining()).toBe(before - 1);
    });
  });

  describe('a batch', () => {
    it('charges nothing when its target formats are not JSON', async () => {
      const client = visitor();
      const before = await client.remaining();

      const res = await batchRoute(batchRequest(client, [{ name: 'scores.csv', content: CSV }], '{not json'));

      expect(res.status).toBe(400);
      expect(await client.remaining()).toBe(before);
    });

    it('charges one conversion for each file that was converted, not for a file it had to skip', async () => {
      const client = visitor();
      const before = await client.remaining();

      const res = await batchRoute(
        batchRequest(
          client,
          [
            { name: 'scores.csv', content: CSV },
            { name: 'other.zzzz', content: CSV },
          ],
          JSON.stringify({ default: 'json' })
        )
      );

      expect(res.status).toBe(200);
      expect(await client.remaining()).toBe(before - 1);
    });
  });
});

describe('the anonymous allowance behind the production proxy', () => {
  const root = path.join(__dirname, '..');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf-8');
  const nginx = fs.readFileSync(path.join(root, 'deploy', 'oci', 'nginx-easyconvert.conf'), 'utf-8');
  /** The trust declaration the production stack starts with when the operator sets none. */
  const productionTrustedProxies = /TRUSTED_PROXIES: \$\{EASYCONVERT_TRUSTED_PROXIES:-([^}]+)\}/.exec(compose)?.[1] ?? '';

  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXIES', productionTrustedProxies);
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(DAY_ALLOWANCE));
    redisKeyStore.resetStore();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const anonymousRequest = (forwardedFor: string) =>
    new NextRequest('http://localhost/api/convert', { method: 'POST', headers: { 'x-forwarded-for': forwardedFor } });
  const reserve = (forwardedFor: string) =>
    validateApiAccess(anonymousRequest(forwardedFor), { requiredUnits: 1, allowAnonymous: true });

  it('declares the host proxy as the one trusted hop, and the proxy writes the client address as the only entry', () => {
    expect(productionTrustedProxies).toBe('127.0.0.1/32,172.16.0.0/12');
    expect(nginx).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(nginx).toMatch(/real_ip_header CF-Connecting-IP;/);
  });

  it('counts each visitor by the address the proxy reports, so one visitor using the allowance leaves another theirs', async () => {
    for (let i = 0; i < DAY_ALLOWANCE; i++) {
      const auth = await reserve('198.51.100.7');
      expect(auth.user?.id).toBe('anon:198.51.100.7');
      await redisKeyStore.commitQuota(auth.reservationId as string);
    }

    const sameVisitor = await reserve('198.51.100.7');
    const otherVisitor = await reserve('198.51.100.8');

    expect([sameVisitor.authorized, sameVisitor.status]).toEqual([false, HTTP_TOO_MANY_REQUESTS]);
    expect([otherVisitor.authorized, otherVisitor.user?.id]).toEqual([true, 'anon:198.51.100.8']);
  });

  it('ignores addresses a client wrote to the left of the one the proxy appended', async () => {
    const forged = await reserve('9.9.9.9, 198.51.100.7');
    expect(forged.user?.id).toBe('anon:198.51.100.7');
  });

  it('gives no per-visitor allowance when the operator declares TRUSTED_PROXIES=none, which is why the stack does not', async () => {
    vi.stubEnv('TRUSTED_PROXIES', 'none');
    const first = await reserve('198.51.100.7');
    const second = await reserve('198.51.100.8');
    expect([first.user?.id, second.user?.id]).toEqual(['anon:unattributed', 'anon:unattributed']);
    expect([first.reservationId, second.reservationId]).toEqual([undefined, undefined]);
  });
});
