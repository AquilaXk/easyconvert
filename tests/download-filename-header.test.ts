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
vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { fetch as undiciFetch } from 'undici';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as fetchUrlRoute } from '../src/app/api/fetch-url/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { userStore } from '../src/lib/auth/user-store';

/**
 * A file whose name is not ASCII (a Korean PDF, as people name them) is answered with its download name in the RFC 6266
 * `filename*` form. A raw non-Latin-1 name in the header made the Fetch API throw while the answer was built, after the
 * conversion had run, and the legacy route answered that as a 400 refusal of the file and charged it.
 */

const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const KOREAN_STEM = '농협 IT 전공직 문제집';
const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));
const BYTE_STRING_FAULT = 'Cannot convert argument to a ByteString because the character at index 22 has a value of 45453 which is greater than 255.';

let nextClient = 1;

function visitor() {
  const ip = `203.0.113.${nextClient++}`;
  return {
    headers: { 'x-forwarded-for': ip },
    remaining: async () => (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining,
  };
}

function pdfForm(fileName: string): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PDF)], fileName, { type: 'application/pdf' }));
  form.append('targetFormat', 'docx');
  return form;
}

function utf8FilenameOf(disposition: string | null): string | undefined {
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition ?? '');
  return match ? decodeURIComponent(match[1]) : undefined;
}

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  redisKeyStore.resetStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(undiciFetch).mockReset();
});

describe('POST /api/convert with a Korean file name', () => {
  it('answers the DOCX with the name in filename* and charges one conversion', async () => {
    const client = visitor();
    const before = await client.remaining();

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: client.headers, body: pdfForm(`${KOREAN_STEM}.pdf`) }));

    expect(res.status, await res.clone().text().then((t) => t.slice(0, 300))).toBe(HTTP_OK);
    expect(utf8FilenameOf(res.headers.get('content-disposition'))).toBe(`${KOREAN_STEM}.docx`);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString('latin1')).toBe('PK');
    expect(await client.remaining()).toBe(before - 1);
  });

  it('answers a TypeError of the server as a 500 that charges nothing, not as a refusal of the file', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new TypeError(BYTE_STRING_FAULT));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = visitor();
    const before = await client.remaining();

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: client.headers, body: pdfForm('report.pdf') }));

    expect(res.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(await res.json())).not.toContain('ByteString');
    expect(await client.remaining()).toBe(before);
    errors.mockRestore();
  });
});

describe('POST /api/v1/convert?raw=true with a Korean file name', () => {
  it('answers the DOCX bytes with the name in filename*', async () => {
    const user = await userStore.createUser({
      name: 'Filename Tester',
      email: `filename_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Filename Key', { scopes: ['convert:write'] });

    const res = await v1ConvertRoute(
      new NextRequest('http://localhost/api/v1/convert?raw=true', { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: pdfForm(`${KOREAN_STEM}.pdf`) })
    );

    expect(res.status, await res.clone().text().then((t) => t.slice(0, 300))).toBe(HTTP_OK);
    expect(utf8FilenameOf(res.headers.get('content-disposition'))).toBe(`${KOREAN_STEM}.docx`);
  });
});

describe('POST /api/fetch-url of a file the remote names in Korean', () => {
  it('answers the file with the name in filename*', async () => {
    const client = visitor();
    vi.mocked(undiciFetch).mockResolvedValue(
      new Response('name,score\n', {
        status: 200,
        headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('점수표.csv')}` },
      }) as never
    );

    const res = await fetchUrlRoute(
      new NextRequest('http://localhost/api/fetch-url', {
        method: 'POST',
        headers: { ...client.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://files.example.com/scores' }),
      })
    );

    expect(res.status, await res.clone().text().then((t) => t.slice(0, 300))).toBe(HTTP_OK);
    expect(utf8FilenameOf(res.headers.get('content-disposition'))).toBe('점수표.csv');
  });
});

describe('POST /api/fetch-url of a file whose name the remote gives with a percent sign', () => {
  async function importNamed(contentDisposition: string) {
    const client = visitor();
    vi.mocked(undiciFetch).mockResolvedValue(
      new Response('name,score\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': contentDisposition } }) as never
    );
    return fetchUrlRoute(
      new NextRequest('http://localhost/api/fetch-url', {
        method: 'POST',
        headers: { ...client.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://files.example.com/scores' }),
      })
    );
  }

  it('keeps a name that is not valid percent-encoding as the remote wrote it, instead of failing after the import was charged', async () => {
    const res = await importNamed('attachment; filename="100%.csv"');

    expect(res.status, await res.clone().text().then((t) => t.slice(0, 300))).toBe(HTTP_OK);
    expect(utf8FilenameOf(res.headers.get('content-disposition'))).toBe('100%.csv');
  });

  it('still decodes a name in the encoded form', async () => {
    const res = await importNamed(`attachment; filename*=UTF-8''100%25.csv`);

    expect(res.status).toBe(HTTP_OK);
    expect(utf8FilenameOf(res.headers.get('content-disposition'))).toBe('100%.csv');
  });
});

describe('POST /api/fetch-url names the file by RFC 6266 and by its media type', () => {
  async function importFrom(headers: Record<string, string>, url = 'https://files.example.com/scores') {
    const client = visitor();
    vi.mocked(undiciFetch).mockResolvedValue(new Response('name,score\n', { status: 200, headers }) as never);
    return fetchUrlRoute(
      new NextRequest('http://localhost/api/fetch-url', {
        method: 'POST',
        headers: { ...client.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      })
    );
  }

  const nameOf = async (res: Response) => {
    expect(res.status, await res.clone().text().then((t) => t.slice(0, 300))).toBe(HTTP_OK);
    return utf8FilenameOf(res.headers.get('content-disposition'));
  };

  it('prefers filename* over a filename that comes before it', async () => {
    const res = await importFrom({
      'content-type': 'text/csv',
      'content-disposition': `attachment; filename="fallback.txt"; filename*=UTF-8''${encodeURIComponent('한글.csv')}`,
    });
    expect(await nameOf(res)).toBe('한글.csv');
  });

  it('decodes an ISO-8859-1 filename* and a quoted filename with escapes', async () => {
    expect(await nameOf(await importFrom({ 'content-type': 'text/csv', 'content-disposition': "attachment; filename*=ISO-8859-1'en'caf%e9.csv" }))).toBe('café.csv');
    expect(await nameOf(await importFrom({ 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="a\\"b.csv"' }))).toBe('ab.csv');
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'download.docx'],
    ['audio/mpeg', 'download.mp3'],
    ['application/x-yaml; charset=utf-8', 'download.yaml'],
    ['image/jpeg', 'download.jpg'],
    ['application/x-unlisted-type', 'download.bin'],
  ])('gives a link with no extension the extension of its type %s', async (contentType, expected) => {
    expect(await nameOf(await importFrom({ 'content-type': contentType }, 'https://files.example.com/download'))).toBe(expected);
  });
});
