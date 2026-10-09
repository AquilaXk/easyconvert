import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../src/lib/conversions/dispatch', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/conversions/dispatch')>();
  return { ...original, dispatchConversion: vi.fn() };
});

import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { RequestAbortedError } from '../src/lib/types';

/**
 * The synchronous conversion routes run under the same deadline as a queued job and stop when the client goes away.
 * The deadline is made small through the documented settings, so the test waits for a real timer, not a fake one.
 */

const BASE_URL = 'http://localhost:3000';
const DEADLINE_MS = 300;
const RESPONSE_BOUND_MS = 3_000;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_CLIENT_CLOSED = 499;
const JOB_TIMEOUT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/job-timeout';
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';

interface Seen {
  options: Record<string, unknown>;
  signal: AbortSignal;
}

const dispatch = vi.mocked(dispatchConversion);
let apiKey = '';
let userId = '';
let seen: Seen[];

beforeEach(async () => {
  vi.stubEnv('JOB_DEADLINE_BASE_MS_FREE', '100');
  vi.stubEnv('JOB_DEADLINE_MAX_MS_FREE', String(DEADLINE_MS));
  seen = [];
  const user = await userStore.createUser({
    email: `sync_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@deadline.test`,
    name: 'Sync Deadline',
    tier: 'free',
  });
  userId = user.id;
  apiKey = (await redisKeyStore.generateApiKey(user.id, 'Sync Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
});

afterEach(() => {
  dispatch.mockReset();
  vi.unstubAllEnvs();
});

/** A conversion that never ends and never looks at its signal. */
function hangIgnoringSignal(): void {
  dispatch.mockImplementation((async (_input: unknown, _s: string, _t: string, options: Record<string, unknown>) => {
    seen.push({ options, signal: options.signal as AbortSignal });
    return new Promise(() => undefined);
  }) as never);
}

/** A conversion that never ends on its own and stops, as a well-behaved engine does, when its signal fires. */
function hangHonoringSignal(onStart?: () => void): void {
  dispatch.mockImplementation((async (_input: unknown, _s: string, _t: string, options: Record<string, unknown>) => {
    const signal = options.signal as AbortSignal;
    seen.push({ options, signal });
    onStart?.();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as never);
}

function csvForm(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('file', new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormat', 'json');
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

function batchForm(): FormData {
  const form = new FormData();
  form.append('files', new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormats', JSON.stringify({ default: 'json' }));
  return form;
}

interface RouteCase {
  label: string;
  path: string;
  call: (req: NextRequest) => Promise<Response>;
  form: () => FormData;
}

const ROUTES: RouteCase[] = [
  { label: 'POST /api/convert', path: '/api/convert', call: convertRoute, form: csvForm },
  { label: 'POST /api/v1/convert', path: '/api/v1/convert', call: v1ConvertRoute, form: csvForm },
  { label: 'POST /api/convert/batch', path: '/api/convert/batch', call: batchRoute, form: batchForm },
];

function request(route: RouteCase, signal?: AbortSignal): NextRequest {
  return new NextRequest(`${BASE_URL}${route.path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: route.form(),
    signal,
  });
}

describe.each(ROUTES)('$label', (route) => {
  it('answers a typed 504 within the bound when the conversion never ends, and aborts the conversion', async () => {
    hangIgnoringSignal();
    const startedAt = Date.now();
    const res = await route.call(request(route));
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(HTTP_GATEWAY_TIMEOUT);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS + RESPONSE_BOUND_MS);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.status).toBe(HTTP_GATEWAY_TIMEOUT);
    expect(body.type).toBe(JOB_TIMEOUT_PROBLEM_TYPE);
    expect(body.timeoutMs).toBe(DEADLINE_MS);
    expect(body.success).toBe(false);
    expect(body.detail).toContain('time limit');

    expect(seen).toHaveLength(1);
    expect(seen[0].options.timeoutMs).toBe(DEADLINE_MS);
    expect(seen[0].signal.aborted).toBe(true);
  });

  it('answers the same 504 for an engine that stops when its signal fires', async () => {
    hangHonoringSignal();
    const res = await route.call(request(route));
    expect(res.status).toBe(HTTP_GATEWAY_TIMEOUT);
    expect((await res.json()).type).toBe(JOB_TIMEOUT_PROBLEM_TYPE);
  });

  it('gives the conversion the deadline in timeoutMs and replaces a client-supplied one', async () => {
    dispatch.mockImplementation((async (_input: unknown, _s: string, _t: string, options: Record<string, unknown>) => {
      seen.push({ options, signal: options.signal as AbortSignal });
      throw new Error('stop after the options are captured');
    }) as never);
    await route.call(request(route));
    expect(seen).toHaveLength(1);
    expect(seen[0].options.timeoutMs).toBe(DEADLINE_MS);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].signal.aborted).toBe(false);
  });

  it('aborts the conversion when the client disconnects, and charges no quota', async () => {
    const client = new AbortController();
    const started = new Promise<void>((resolve) => hangHonoringSignal(resolve));
    const quotaBefore = JSON.stringify(await redisKeyStore.getQuotaUsage(userId));
    const pending = route.call(request(route, client.signal));
    await started;
    const abortedAt = Date.now();
    client.abort();
    const res = await pending;

    expect(Date.now() - abortedAt).toBeLessThan(RESPONSE_BOUND_MS);
    expect(res.status).toBe(HTTP_CLIENT_CLOSED);
    expect(seen).toHaveLength(1);
    expect(seen[0].signal.aborted).toBe(true);
    expect(seen[0].signal.reason).toBeInstanceOf(RequestAbortedError);
    expect(JSON.stringify(await redisKeyStore.getQuotaUsage(userId))).toBe(quotaBefore);
  });

  it('does not start the conversion for a client that is already gone', async () => {
    const client = new AbortController();
    client.abort();
    hangHonoringSignal();
    const res = await route.call(request(route, client.signal));
    expect(res.status).toBe(HTTP_CLIENT_CLOSED);
    expect(seen.every((call) => call.signal.aborted)).toBe(true);
  });
});

describe('a conversion that finishes inside its deadline', () => {
  it('is answered normally and leaves no timer behind that aborts its signal later', async () => {
    dispatch.mockImplementation((async (_input: unknown, _s: string, _t: string, options: Record<string, unknown>) => {
      seen.push({ options, signal: options.signal as AbortSignal });
      return {
        buffer: Buffer.from('[]'),
        size: 2,
        mimeType: 'application/json',
        filename: 'scores.json',
        engineUsed: 'internal-fallback',
      };
    }) as never);
    const res = await convertRoute(
      new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: csvForm() })
    );
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 150));
    expect(seen[0].signal.aborted).toBe(false);
  });
});

describe('the media ceiling on the synchronous routes', () => {
  /** RIFF/WAVE header of an empty PCM stream: the magic bytes the spoof check reads. */
  const WAV = Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]),
    Buffer.from('data'), Buffer.from([0, 0, 0, 0]),
  ]);
  const MEDIA_MAX_MS = 180_000;

  it.each([
    ['POST /api/convert', '/api/convert', convertRoute],
    ['POST /api/v1/convert', '/api/v1/convert', v1ConvertRoute],
  ])('%s gives a free media conversion at most 180 000 ms even when the job deadline is longer', async (_label, route, call) => {
    vi.stubEnv('JOB_DEADLINE_BASE_MS_FREE', '500000');
    vi.stubEnv('JOB_DEADLINE_MAX_MS_FREE', '600000');
    dispatch.mockImplementation((async (_input: unknown, _s: string, _t: string, options: Record<string, unknown>) => {
      seen.push({ options, signal: options.signal as AbortSignal });
      throw new Error('stop after the options are captured');
    }) as never);
    const form = new FormData();
    form.append('file', new File([new Uint8Array(WAV)], 'clip.wav', { type: 'audio/wav' }));
    form.append('targetFormat', 'mp3');
    await call(new NextRequest(`${BASE_URL}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form }));
    expect(seen).toHaveLength(1);
    expect(seen[0].options.timeoutMs).toBe(MEDIA_MAX_MS);
  });
});
