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

vi.mock('@/lib/storage/retention-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/retention-service')>();
  return { ...actual, admitsNewFiles: vi.fn(actual.admitsNewFiles) };
});

import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { admitsNewFiles } from '../src/lib/storage/retention-service';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { MAX_PASSWORD_LIST_ITEMS } from '../src/lib/api/contracts/schemas';
import { ImportBudgetExceededError, UnsupportedTargetError } from '../src/lib/types';

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
  error?: { class: string; message?: string; frames?: string[] };
}

function pdfForm(target: string, options?: Record<string, unknown>, fileName = `${PRIVATE_NAME}.pdf`): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PDF)], fileName, { type: 'application/pdf' }));
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
    expect(line.outcome.error?.frames?.length).toBeGreaterThan(0);
    expect(JSON.stringify([...error.mock.calls, ...warn.mock.calls])).not.toMatch(new RegExp(`${PRIVATE_NAME}|${PASSWORD}`));
  });

  it('logs a typed refusal of the conversion by its code and class, without the message', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new UnsupportedTargetError('No writer for the text "Quarterly results"'));

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }));

    expect(res.status).toBe(400);
    const [line] = outcomesOf(warn, '[convert] refusal ');
    expect(line.outcome).toMatchObject({ status: 400, code: 'unsupported_pair' });
    expect(line.outcome.error).toEqual({ class: 'UnsupportedTargetError' });
    expect(line.raw).not.toContain('Quarterly');
    expect(error.mock.calls).toHaveLength(0);
  });

  it.each(['a.pdf', '1.pdf'])('keeps a message whole when the name %s and the password are shorter than three characters', async (fileName) => {
    const message = 'Invalid array length at offset 4096 (page 12)';
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError(message));

    await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx', { password: 'e' }, fileName) }));

    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome.error?.message).toBe(message);
    expect(line.raw).not.toContain('[r[');
  });

  it('cuts a short name out where it stands alone', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError("cannot open '/tmp/job/a.zip' on page 3"));

    await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx', {}, 'a.pdf') }));

    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome.error?.message).toBe("cannot open '/tmp/job/[redacted].zip' on page 3");
  });

  it('cuts out the passwords a PDF is protected with', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError('qpdf rejected owner-pass-77 and user-pass-42'));

    await convertRoute(
      new NextRequest('http://localhost/api/convert', {
        method: 'POST',
        headers: VISITOR,
        body: pdfForm('docx', { protect: { userPassword: 'user-pass-42', ownerPassword: 'owner-pass-77' } }),
      })
    );

    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome.error?.message).toBe('qpdf rejected [redacted] and [redacted]');
  });

  it('cuts out the leaf of a name sent with a path, in its composed, decomposed and percent-encoded forms', async () => {
    const stem = '홍길동 이력서';
    vi.mocked(dispatchConversion).mockRejectedValueOnce(
      new RangeError(`open ${encodeURIComponent(stem)}.zip, then ${stem.normalize('NFD')}, then ${stem}`)
    );

    await convertRoute(
      new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx', {}, `C:\\Users\\kim\\${stem.normalize('NFD')}.pdf`) })
    );

    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome.error?.message).toBe('open [redacted].zip, then [redacted], then [redacted]');
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

  it('leave no line for a rate limit, which no error decided', async () => {
    vi.mocked(validateApiAccess).mockResolvedValueOnce({ authorized: false, status: 429, error: 'Too many requests' });

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }));

    expect(res.status).toBe(429);
    expect(warn.mock.calls).toHaveLength(0);
    expect(error.mock.calls).toHaveLength(0);
  });

  it('leave a line for a 429 that a typed error of the conversion decided', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new ImportBudgetExceededError('no bytes left today'));

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }));

    expect(res.status).toBe(429);
    expect(outcomesOf(warn, '[convert] refusal ')).toHaveLength(1);
  });

  it('leave no line for the 503 of a full disk', async () => {
    vi.mocked(admitsNewFiles).mockResolvedValueOnce(false);

    const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx') }));

    expect(res.status).toBe(503);
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

describe('the secrets the log line cuts out', () => {
  const MARKER = 'pw-marker-';
  const MARKED = { password: `${MARKER}open`, passwords: [`${MARKER}one`, `${MARKER}two`], protect: { userPassword: `${MARKER}user`, ownerPassword: `${MARKER}owner` } };

  async function v1Headers(): Promise<Record<string, string>> {
    const user = await userStore.createUser({
      name: 'Secrets Tester',
      email: `secrets_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Secrets Key', { scopes: ['convert:write'] });
    return { Authorization: `Bearer ${secretKey}` };
  }

  const ROUTES = [
    { name: 'POST /api/convert', prefix: '[convert]', headers: async () => VISITOR, post: convertRoute, url: 'http://localhost/api/convert', invalid: { pages: 'garbage' }, invalidStatus: 400 },
    { name: 'POST /api/v1/convert', prefix: '[v1/convert]', headers: v1Headers, post: v1ConvertRoute, url: 'http://localhost/api/v1/convert', invalid: { quality: 1000 }, invalidStatus: 422 },
  ] as const;

  /** What the passwords cost: the texts of the options that were encoded for the matcher. */
  let encodings: { mock: { calls: unknown[][] }; mockRestore(): void };
  const encodedSecrets = () => encodings.mock.calls.filter(([text]) => String(text).includes(MARKER)).length;

  beforeEach(() => {
    encodings = vi.spyOn(globalThis, 'encodeURIComponent');
  });

  afterEach(() => {
    encodings.mockRestore();
  });

  describe.each(ROUTES)('$name', (route) => {
    const send = async (options: Record<string, unknown>) =>
      route.post(new NextRequest(route.url, { method: 'POST', headers: await route.headers(), body: pdfForm('docx', options) }));

    it('reads the passwords of the options for nothing while the conversion succeeds', async () => {
      const res = await send({ password: MARKED.password, passwords: MARKED.passwords });

      expect(res.status).toBe(200);
      expect(encodedSecrets()).toBe(0);
    });

    it('reads the passwords of the options for nothing while a request is refused for its options', async () => {
      const res = await send({ ...MARKED, ...route.invalid });

      expect(res.status).toBe(route.invalidStatus);
      expect(encodedSecrets()).toBe(0);
    });

    it('refuses a list of more passwords than the schema allows before any of them is read', async () => {
      const res = await send({ passwords: Array.from({ length: MAX_PASSWORD_LIST_ITEMS + 1 }, (_, at) => `${MARKER}${at}`) });

      expect(res.status).toBe(route.invalidStatus);
      expect(encodedSecrets()).toBe(0);
    });

    it('encodes a password listed again and again once for the line of a failure', async () => {
      vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError('qpdf failed'));

      const res = await send({ password: MARKED.password, passwords: Array.from({ length: MAX_PASSWORD_LIST_ITEMS }, () => MARKED.password) });

      expect(res.status).toBe(500);
      expect(encodedSecrets()).toBe(1);
    });

    it('reads the passwords of the options for nothing while the conversion refuses the file', async () => {
      vi.mocked(dispatchConversion).mockRejectedValueOnce(new UnsupportedTargetError('No writer for this file'));

      const res = await send({ ...MARKED });

      expect(res.status).toBe(400);
      expect(encodedSecrets()).toBe(0);
    });

    it('reads them for the line of a failure of the server, and cuts them out of it', async () => {
      vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError(`qpdf rejected ${MARKED.protect.ownerPassword} and ${MARKED.passwords[1]}`));

      const res = await send({ ...MARKED });

      expect(res.status).toBe(500);
      expect(encodedSecrets()).toBeGreaterThan(0);
      const [line] = outcomesOf(error, `${route.prefix} failure `);
      expect(line.outcome.error?.message).toBe('qpdf rejected [redacted] and [redacted]');
    });
  });

  it('cuts out a name sent decomposed from a message that holds it percent-encoded in the decomposed form', async () => {
    const stem = '홍길동 이력서'.normalize('NFD');
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError(`GET /files/${encodeURIComponent(stem)}.zip`));

    await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', headers: VISITOR, body: pdfForm('docx', {}, `${stem}.pdf`) }));

    const [line] = outcomesOf(error, '[convert] failure ');
    expect(line.outcome.error?.message).toBe('GET /files/[redacted].zip');
  });
});
