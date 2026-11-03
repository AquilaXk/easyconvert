import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

vi.mock('@/lib/api-keys/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-keys/guard')>();
  return { ...actual, validateApiAccess: vi.fn(actual.validateApiAccess) };
});

import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { UnsupportedTargetError } from '../src/lib/types';

/**
 * Every refusal and failure of the convert routes leaves one line in the server log: its status, code, formats, size,
 * duration and request id, and nothing of the file's name, its options or its password.
 */

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));
const PRIVATE_NAME = 'salary-review-kim';
const PASSWORD = 'hunter2-secret';
const VISITOR = { 'x-forwarded-for': '203.0.113.77' };

interface LoggedOutcome {
  status: number;
  code?: string;
  source?: string;
  target?: string;
  bytes?: number;
  durationMs: number;
  requestId: string;
  error?: { class: string; message: string; frames: string[] };
}

function pdfForm(target: string, options?: Record<string, unknown>): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PDF)], `${PRIVATE_NAME}.pdf`, { type: 'application/pdf' }));
  form.append('targetFormat', target);
  if (options) form.append('options', JSON.stringify(options));
  return form;
}

type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore(): void; mockImplementationOnce(implementation: () => void): unknown };

/** The outcome lines `spy` received under `prefix`, parsed. */
function outcomesOf(spy: ConsoleSpy, prefix: string): { raw: string; outcome: LoggedOutcome }[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith(prefix))
    .map((raw) => ({ raw, outcome: JSON.parse(raw.slice(prefix.length)) as LoggedOutcome }));
}

let warn: ConsoleSpy;
let error: ConsoleSpy;

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  redisKeyStore.resetStore();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
  error.mockRestore();
});

describe('POST /api/convert', () => {
  it('logs a refusal with its code, formats, size and id, and not the name or the password', async () => {
    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('mp3', { password: PASSWORD }) }));

    expect(res.status).toBe(400);
    const lines = outcomesOf(warn, '[convert] refusal ');
    expect(lines).toHaveLength(1);
    const [{ raw, outcome }] = lines;
    expect(outcome).toMatchObject({ status: 400, code: 'unsupported_pair', source: 'pdf', target: 'mp3', bytes: PDF.length });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(raw).not.toContain(PRIVATE_NAME);
    expect(raw).not.toContain(PASSWORD);
  });

  it('logs a failure of the server as the one error line, with the class of its error and a message free of the name and the password', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError(`Invalid length while reading ${PRIVATE_NAME}.pdf opened with ${PASSWORD}`));

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx', { password: PASSWORD }) }));

    expect(res.status).toBe(500);
    expect(error.mock.calls).toHaveLength(1);
    expect(warn.mock.calls).toHaveLength(0);
    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome).toMatchObject({ status: 500, source: 'pdf', target: 'docx', bytes: PDF.length });
    expect(line.outcome.error).toMatchObject({ class: 'RangeError', message: 'Invalid length while reading [redacted] opened with [redacted]' });
    expect(line.outcome.error?.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify([...error.mock.calls, ...warn.mock.calls])).not.toMatch(new RegExp(`${PRIVATE_NAME}|${PASSWORD}`));
  });

  it('logs a typed refusal of the conversion with the class of its error', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new UnsupportedTargetError(`No writer for ${PRIVATE_NAME}`));

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }));

    expect(res.status).toBe(400);
    const [line] = outcomesOf(warn, '[convert] refusal ');
    expect(line.outcome).toMatchObject({ status: 400, code: 'unsupported_pair', error: { class: 'UnsupportedTargetError', message: 'No writer for [redacted]' } });
    expect(error.mock.calls).toHaveLength(0);
  });

  it('logs a failure once for an error thrown before the handler reached its own error handling, and throws it again', async () => {
    const fault = new Error('redis offline');
    vi.mocked(validateApiAccess).mockRejectedValueOnce(fault);

    await expect(convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }))).rejects.toBe(fault);

    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome).toMatchObject({ status: 500, error: { class: 'Error', message: 'redis offline' } });
    expect(error.mock.calls).toHaveLength(1);
  });

  it('answers as it would without the log when writing the line fails', async () => {
    warn.mockImplementationOnce(() => {
      throw new Error('stderr closed');
    });

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('mp3') }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unsupported_pair' });
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual(['[convert] outcome line not written: Error']);
  });

  it.each([
    ['with a leading dot', '.mp3', 'mp3'],
    ['with capitals', 'MP3', 'mp3'],
    ['with a name an object of the language also has', 'constructor', undefined],
  ])('names the target of the registry by its extension, %s', async (_case, sent, target) => {
    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm(sent) }));

    expect(res.status).toBe(400);
    const [line] = outcomesOf(warn, '[convert] refusal ');
    expect(line.outcome.target).toBe(target);
  });

  it('logs nothing for a conversion that succeeds', async () => {
    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }));

    expect(res.status).toBe(200);
    expect(outcomesOf(warn, '[convert] ')).toHaveLength(0);
    expect(outcomesOf(error, '[convert] ')).toHaveLength(0);
  });
});

describe('POST /api/v1/convert', () => {
  it('logs a refusal with the problem type as its code', async () => {
    const user = await userStore.createUser({
      name: 'Outcome Log Tester',
      email: `outcome_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Outcome Key', { scopes: ['convert:write'] });

    const res = await v1ConvertRoute(
      new NextRequest('http://localhost/api/v1/convert', { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: pdfForm('mp3') })
    );

    expect(res.status).toBe(400);
    const [line] = outcomesOf(warn, '[v1/convert] refusal ');
    expect(line.outcome).toMatchObject({ status: 400, code: 'bad-request', source: 'pdf', target: 'mp3', bytes: PDF.length });
    expect(line.raw).not.toContain(PRIVATE_NAME);
  });

  it('logs the target of the registry the same way', async () => {
    const user = await userStore.createUser({
      name: 'Outcome Target Tester',
      email: `target_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Target Key', { scopes: ['convert:write'] });

    const res = await v1ConvertRoute(
      new NextRequest('http://localhost/api/v1/convert', { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: pdfForm('constructor') })
    );

    expect(res.status).toBe(400);
    const [line] = outcomesOf(warn, '[v1/convert] refusal ');
    expect(line.outcome.target).toBeUndefined();
  });

  it('logs a failure of the server as one error line with the class of its error', async () => {
    const user = await userStore.createUser({
      name: 'Outcome Failure Tester',
      email: `failure_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Failure Key', { scopes: ['convert:write'] });
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError(`Invalid length in ${PRIVATE_NAME}.pdf`));

    const res = await v1ConvertRoute(
      new NextRequest('http://localhost/api/v1/convert', { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: pdfForm('docx') })
    );

    expect(res.status).toBe(500);
    expect(error.mock.calls).toHaveLength(1);
    const [line] = outcomesOf(error, '[v1/convert] failure ');
    expect(line.outcome).toMatchObject({ status: 500, error: { class: 'RangeError', message: 'Invalid length in [redacted]' } });
    expect(JSON.stringify(error.mock.calls)).not.toContain(PRIVATE_NAME);
  });
});

describe('answers that turn a caller away before any work', () => {
  it('leave no line for a request without credentials', async () => {
    const res = await v1ConvertRoute(new NextRequest('http://localhost/api/v1/convert', { method: 'POST', body: pdfForm('docx') }));

    expect(res.status).toBe(401);
    expect(warn.mock.calls).toHaveLength(0);
    expect(error.mock.calls).toHaveLength(0);
  });

  it('leave no line for a body declared over the largest single request', async () => {
    const headers = { ...VISITOR, 'content-length': String(1024 ** 4), 'content-type': 'multipart/form-data; boundary=xx' };

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers, body: 'x' }));

    expect(res.status).toBe(413);
    expect(warn.mock.calls).toHaveLength(0);
    expect(error.mock.calls).toHaveLength(0);
  });
});
