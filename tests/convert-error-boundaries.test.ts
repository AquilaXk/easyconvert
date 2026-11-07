import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});
vi.mock('@/lib/api/content-disposition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/content-disposition')>();
  return { ...actual, attachmentContentDisposition: vi.fn(actual.attachmentContentDisposition) };
});

import { POST as convertRoute } from '../src/app/api/convert/route';
import { attachmentContentDisposition } from '../src/lib/api/content-disposition';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { RESERVATION_LEASE } from '../src/lib/api-keys/reservation-ledger';
import { UnsupportedTargetError } from '../src/lib/types';

/**
 * What `/api/convert` answers for an error depends on where it came from. An error the conversion threw is read by its type: a
 * typed refusal of the input is a 400, anything else a fault of the server (500). An answer that cannot be built, or a unit
 * that cannot be committed, is a fault of the server whatever the error says, and charges nothing: the words of such an error
 * (`Cannot convert ...` is what the Fetch API says of a header) must not turn it into a refusal of a file that converted.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));
const REFUSAL_WORDS = 'Cannot convert the header value: Unsupported compression';

let nextClient = 100;

function visitor() {
  const ip = `203.0.113.${nextClient++}`;
  return {
    headers: { 'x-forwarded-for': ip },
    remaining: async () => (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining,
  };
}

function pdfForm(): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PDF)], 'report.pdf', { type: 'application/pdf' }));
  form.append('targetFormat', 'docx');
  return form;
}

const post = (headers: Record<string, string>, body: BodyInit) =>
  convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers, body }));

type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore(): void };
let warn: ConsoleSpy;
let error: ConsoleSpy;

const loggedLines = () => [...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0]));

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  redisKeyStore.resetStore();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('an answer of /api/convert that cannot be built', () => {
  it('is a 500 that charges nothing and leaves one log line, whatever the words of its error', async () => {
    vi.mocked(attachmentContentDisposition).mockImplementationOnce(() => {
      throw new Error(REFUSAL_WORDS);
    });
    const client = visitor();
    const before = await client.remaining();

    const res = await post(client.headers, pdfForm());

    expect(res.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(await res.json())).not.toContain('Cannot convert');
    expect(await client.remaining()).toBe(before);
    expect(loggedLines()).toEqual([expect.stringMatching(/^\[convert\] failure /)]);
  });

  it('is answered and charged once the same file is sent again', async () => {
    vi.mocked(attachmentContentDisposition).mockImplementationOnce(() => {
      throw new Error(REFUSAL_WORDS);
    });
    const client = visitor();
    const before = await client.remaining();

    await post(client.headers, pdfForm());
    const retry = await post(client.headers, pdfForm());

    expect(retry.status).toBe(200);
    expect(await client.remaining()).toBe(before - 1);
  });
});

describe('a unit that cannot be committed', () => {
  it('is a 500 and one log line, not a refusal of the file, whatever the words of its error', async () => {
    vi.spyOn(redisKeyStore, 'commitQuota').mockRejectedValueOnce(new Error(REFUSAL_WORDS));

    const res = await post(visitor().headers, pdfForm());

    expect(res.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(loggedLines()).toEqual([expect.stringMatching(/^\[convert\] failure /)]);
  });

  it('charges nothing: the reservation is given back when its lease ends', async () => {
    vi.spyOn(redisKeyStore, 'commitQuota').mockRejectedValueOnce(new Error(REFUSAL_WORDS));
    const client = visitor();
    const before = await client.remaining();

    await post(client.headers, pdfForm());
    const leaseEnd = Date.now() + RESERVATION_LEASE.provisionalMs + 1;
    vi.spyOn(Date, 'now').mockReturnValue(leaseEnd);

    expect(await client.remaining()).toBe(before);
  });
});

describe('an error the conversion threw', () => {
  it('is a refusal with its own code when its class is a typed refusal of the input', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new UnsupportedTargetError('This engine does not write that target.'));

    const res = await post(visitor().headers, pdfForm());

    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(await res.json()).toMatchObject({ code: 'unsupported_pair' });
  });

  it('is a fault of the server when it is an untyped Error, even one that says the engine cannot convert it', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new Error('Unsupported data conversion from pdf to xyz'));

    const res = await post(visitor().headers, pdfForm());

    expect(res.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
  });

  it('is a fault of the server when it is a TypeError, whatever its words', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new TypeError('Cannot convert undefined or null to object'));

    const res = await post(visitor().headers, pdfForm());

    expect(res.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
  });
});

describe('a body that is not multipart', () => {
  it('is a 400 refusal, not a fault of the server', async () => {
    const client = visitor();

    const res = await post({ ...client.headers, 'content-type': 'multipart/form-data; boundary=xx' }, 'this is not multipart');

    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(await res.json()).toMatchObject({ code: 'multipart_required' });
  });
});
