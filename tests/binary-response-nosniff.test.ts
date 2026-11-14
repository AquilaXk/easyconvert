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
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as fetchUrlRoute } from '../src/app/api/fetch-url/route';
import { POST as rotateRoute } from '../src/app/api/tools/rotate/route';
import { PDFDocument } from 'pdf-lib';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';

/**
 * An answer that carries file bytes names its type itself, and the browser must not guess another one from the bytes: the
 * type of an imported file is the remote's word, and a converted file may hold what a sniffing browser would run as a page.
 */

const HTTP_OK = 200;
let nextClient = 1;

function visitorHeaders(): Record<string, string> {
  return { 'x-forwarded-for': `192.0.2.${nextClient++}` };
}

function csvForm(): FormData {
  const form = new FormData();
  form.append('file', new File(['name,score\nada,1\n'], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormat', 'json');
  return form;
}

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  redisKeyStore.resetStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(undiciFetch).mockReset();
});

const bodyOf = async (res: Response) => (await res.clone().text()).slice(0, 300);

describe('X-Content-Type-Options on the answers that carry file bytes', () => {
  it('is nosniff on the bytes /api/fetch-url imported', async () => {
    vi.mocked(undiciFetch).mockResolvedValue(new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/plain' } }) as never);

    const res = await fetchUrlRoute(
      new NextRequest('http://localhost/api/fetch-url', {
        method: 'POST',
        headers: { ...visitorHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://files.example.com/page' }),
      })
    );

    expect(res.status, await bodyOf(res)).toBe(HTTP_OK);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is nosniff on the file /api/convert answers', async () => {
    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: visitorHeaders(), body: csvForm() }));

    expect(res.status, await bodyOf(res)).toBe(HTTP_OK);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is nosniff on the zip /api/convert/batch answers', async () => {
    const form = new FormData();
    form.append('files', new File(['name,score\nada,1\n'], 'scores.csv', { type: 'text/csv' }));
    form.append('targetFormats', JSON.stringify({ default: 'json' }));

    const res = await batchRoute(new NextRequest('http://localhost/api/convert/batch', { method: 'POST', headers: visitorHeaders(), body: form }));

    expect(res.status, await bodyOf(res)).toBe(HTTP_OK);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is nosniff on the raw file /api/v1/convert answers', async () => {
    const user = await userStore.createUser({
      name: 'Nosniff Tester',
      email: `nosniff_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'paid',
    });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Nosniff Key', { scopes: ['convert:write'] });

    const res = await v1ConvertRoute(
      new NextRequest('http://localhost/api/v1/convert?raw=true', { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: csvForm() })
    );

    expect(res.status, await bodyOf(res)).toBe(HTTP_OK);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is nosniff on the file a tool route answers', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    const form = new FormData();
    form.append('files', new File([new Uint8Array(await doc.save())], 'one.pdf'));
    form.append('options', JSON.stringify({ rotate: { rotation: 90 } }));

    const res = await rotateRoute(new NextRequest('http://localhost/api/tools/rotate', { method: 'POST', headers: visitorHeaders(), body: form }));

    expect(res.status, await bodyOf(res)).toBe(HTTP_OK);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
