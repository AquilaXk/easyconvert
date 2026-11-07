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
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions';
import { convertData } from '../src/lib/conversions/data';
import { convertFont } from '../src/lib/conversions/font';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { ConversionFailedError, CpuTaskAbortedError, EngineUnavailableError, typedFailureOf, UnsupportedTargetError } from '../src/lib/types';
import { createEngineUnavailableResponse } from '../src/lib/api/problem-details';
import { conversionRefusalResponse } from '../src/lib/api/conversion-refusal-response';

/**
 * The error contract of the convert routes: an error answers by its class and never by the words of its message, the batch route
 * answers and logs as the other two do, and a 503 tells the client when to try again.
 */

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));
const PRIVATE_NAME = 'salary-review-kim';
const VISITOR = { 'x-forwarded-for': '203.0.113.88' };
const RETRY_AFTER_SECONDS = '5';

function pdfForm(target: string, fileName = `${PRIVATE_NAME}.pdf`): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PDF)], fileName, { type: 'application/pdf' }));
  form.append('targetFormat', target);
  return form;
}

function batchForm(fileName = `${PRIVATE_NAME}.pdf`): FormData {
  const form = new FormData();
  form.append('files', new File([new Uint8Array(PDF)], fileName, { type: 'application/pdf' }));
  form.append('targetFormats', JSON.stringify({ default: 'docx' }));
  return form;
}

const post = (url: string, body: FormData, headers: Record<string, string> = VISITOR): NextRequest => new NextRequest(`http://localhost${url}`, { method: 'POST', headers, body });

/** The header of a pro caller with an API key, which `/api/v1/convert` requires. */
async function keyHeader(): Promise<Record<string, string>> {
  const user = await userStore.createUser({
    name: 'Contract Tester',
    email: `contract_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Contract Key', { scopes: ['convert:write'] });
  return { Authorization: `Bearer ${secretKey}` };
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

const linesOf = (spy: ReturnType<typeof vi.spyOn>, prefix: string): string[] => spy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith(prefix));

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (failure: unknown) {
    return failure;
  }
  throw new Error('The call did not reject.');
}

describe('an untyped error', () => {
  it.each(['Unsupported thing', 'Cannot convert it', 'PDF OCR failed: x', 'Fail-Closed', 'Failed to parse', 'payload is empty', 'compression'])(
    'is a fault of the server whatever its words say (%s)',
    async (message) => {
      vi.mocked(dispatchConversion).mockRejectedValueOnce(new Error(message));

      const res = await convertRoute(post('/api/convert', pdfForm('docx')));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: 'The conversion failed on the server.' });
    }
  );
});

describe('the throw sites that used to be told apart by their words', () => {
  it.each([
    ['a font', () => convertFont(Buffer.alloc(0), 'ttf', 'woff', {}, 'a.ttf')],
    ['a vector drawing', () => convertVectorCad(Buffer.alloc(0), 'stl', 'obj', {}, 'a.stl')],
    ['a file of any engine', () => convertFile(Buffer.alloc(0), 'pdf', 'txt', {}, 'a.pdf')],
  ])('type an empty payload of %s as a refusal of the input', async (_, run) => {
    expect(typedFailureOf(await rejection(run))).toEqual({ status: 400, code: 'conversion_failed' });
  });

  it.each([
    ['data', () => convertData(Buffer.from('a'), 'zzz', 'json', {}, 'a.zzz')],
    ['any engine', () => convertFile(Buffer.from('a'), 'zzz', 'json', {}, 'a.zzz')],
  ])('type a source no engine of %s reads as an unsupported pair', async (_, run) => {
    expect(typedFailureOf(await rejection(run))).toEqual({ status: 400, code: 'unsupported_pair' });
  });
});

describe('Retry-After on a 503', () => {
  it('is sent with a missing tool', () => {
    const res = createEngineUnavailableResponse(new EngineUnavailableError('ffmpeg'), '/api/convert');

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe(RETRY_AFTER_SECONDS);
  });

  it('is sent while the quota store is offline', () => {
    const res = conversionRefusalResponse({ reserved: false, reason: 'offline', error: 'offline' } as never, '/api/convert');

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe(RETRY_AFTER_SECONDS);
  });

  it.each([
    ['/api/convert', convertRoute, () => pdfForm('docx')],
    ['/api/v1/convert', v1ConvertRoute, () => pdfForm('docx')],
    ['/api/convert/batch', batchRoute, () => batchForm()],
  ] as const)('is sent by %s when the engine is missing', async (url, route, form) => {
    const headers = url.startsWith('/api/v1') ? await keyHeader() : VISITOR;
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new EngineUnavailableError('soffice'));

    const res = await route(post(url, form(), headers));

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe(RETRY_AFTER_SECONDS);
  });
});

describe('POST /api/convert/batch', () => {
  it('answers a fault class with its 500 and a generic detail, as the other routes do', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new CpuTaskAbortedError('zstd'));

    const res = await batchRoute(post('/api/convert/batch', batchForm()));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('zstd');
  });

  it('answers an untyped error with a fixed sentence, not its message', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError(`cannot open /tmp/job/${PRIVATE_NAME}.pdf`));

    const res = await batchRoute(post('/api/convert/batch', batchForm()));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('/tmp/job');
  });

  it('answers a typed refusal with its status and code', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new UnsupportedTargetError('No writer'));

    const res = await batchRoute(post('/api/convert/batch', batchForm()));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unsupported_pair' });
  });

  it('logs a failure as one error line, free of the file name', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new RangeError(`cannot open ${PRIVATE_NAME}.pdf`));

    await batchRoute(post('/api/convert/batch', batchForm()));

    const [line] = linesOf(error, '[convert/batch] failure ');
    expect(line).toBeDefined();
    const outcome = JSON.parse(line.slice('[convert/batch] failure '.length));
    expect(outcome).toMatchObject({ status: 500, bytes: PDF.length, error: { class: 'RangeError', message: 'cannot open [redacted]' } });
    expect(JSON.stringify([...error.mock.calls, ...warn.mock.calls])).not.toContain(PRIVATE_NAME);
  });

  it('logs a refusal as one warning line with its code and class', async () => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new UnsupportedTargetError(`No writer for ${PRIVATE_NAME}`));

    await batchRoute(post('/api/convert/batch', batchForm()));

    const lines = linesOf(warn, '[convert/batch] refusal ');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice('[convert/batch] refusal '.length))).toMatchObject({ status: 400, code: 'unsupported_pair', error: { class: 'UnsupportedTargetError' } });
    expect(lines[0]).not.toContain(PRIVATE_NAME);
  });

  it('logs a refusal that no error decided, an empty list of files', async () => {
    await batchRoute(post('/api/convert/batch', new FormData()));

    expect(linesOf(warn, '[convert/batch] refusal ')).toHaveLength(1);
  });
});
