import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';

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
}

function pdfForm(target: string, options?: Record<string, unknown>): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PDF)], `${PRIVATE_NAME}.pdf`, { type: 'application/pdf' }));
  form.append('targetFormat', target);
  if (options) form.append('options', JSON.stringify(options));
  return form;
}

/** The outcome lines `spy` received under `prefix`, parsed. */
function outcomesOf(spy: ReturnType<typeof vi.spyOn>, prefix: string): { raw: string; outcome: LoggedOutcome }[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith(prefix))
    .map((raw) => ({ raw, outcome: JSON.parse(raw.slice(prefix.length)) as LoggedOutcome }));
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

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

  it('logs a failure of the server as an error line', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new TypeError('Cannot read properties of undefined'));

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }));

    expect(res.status).toBe(500);
    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome).toMatchObject({ status: 500, source: 'pdf', target: 'docx', bytes: PDF.length });
    expect(outcomesOf(warn, '[convert] refusal ')).toHaveLength(0);
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

  it('logs a refusal that comes before the request is read, without formats', async () => {
    const res = await v1ConvertRoute(new NextRequest('http://localhost/api/v1/convert', { method: 'POST', body: pdfForm('docx') }));

    expect(res.status).toBe(401);
    const [line] = outcomesOf(warn, '[v1/convert] refusal ');
    expect(line.outcome.status).toBe(401);
    expect(line.outcome.source).toBeUndefined();
  });
});
