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
import { OcrTextLayerLimitError } from '../src/lib/conversions/ocr-text-layer';
import { AudioResampleFaultError } from '../src/lib/conversions/audio-resampler';
import { AvifEncoderFaultError } from '../src/lib/conversions/avif-cli';
import { LoudnessReportMissingError } from '../src/lib/conversions/media-audio-quality';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import {
  CpuTaskAbortedError,
  CpuTaskTimeoutError,
  GraphStateCorruptError,
  ImportBudgetExceededError,
  InvalidConversionOutputError,
  OcrLanguageDataMissingError,
  OcrLanguageUnknownError,
  OcrPreprocessFaultError,
  RawEngineRequiredError,
  UnknownArtifactFormatError,
} from '../src/lib/types';

/**
 * Both convert routes answer an error the conversion threw by what its class declares: its own status and refusal code, 503
 * for a missing tool, 400 for any other typed refusal. A class that declares a server fault (500) is answered as one and
 * logged as a failure, never as a refusal of the file. Both routes read the body the same way: a body that is not multipart
 * is a 415, a broken one a 400, and a client that went away while it was read a 499.
 */

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));
const HTTP_BAD_REQUEST = 400;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_CLIENT_CLOSED_REQUEST = 499;

let nextClient = 10;
const visitor = () => ({ 'x-forwarded-for': `198.51.100.${nextClient++}` });

async function keyHeaders(): Promise<Record<string, string>> {
  const user = await userStore.createUser({
    name: 'Typed Status Tester',
    email: `typed_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Typed Key', { scopes: ['convert:write'] });
  return { Authorization: `Bearer ${secretKey}` };
}

function pdfForm(): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PDF)], 'report.pdf', { type: 'application/pdf' }));
  form.append('targetFormat', 'docx');
  return form;
}

const ROUTES = [
  {
    name: '/api/convert',
    prefix: '[convert]',
    post: convertRoute,
    url: 'http://localhost/api/convert',
    headers: async () => visitor(),
    faultSentence: 'The conversion failed on the server.',
    textFields: [['sourceFormat', 'unknown_format'], ['options', 'invalid_options']],
  },
  {
    name: '/api/v1/convert',
    prefix: '[v1/convert]',
    post: v1ConvertRoute,
    url: 'http://localhost/api/v1/convert',
    headers: keyHeaders,
    faultSentence: 'Internal conversion error',
    textFields: [['sourceFormat', undefined], ['options', undefined], ['webhookUrl', undefined], ['webhookSecret', undefined]],
  },
] as const;

type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore(): void };
let warn: ConsoleSpy;
let error: ConsoleSpy;

/** The outcome lines of `prefix`, as `kind` (refusal or failure) and the parsed JSON. */
function outcomeLines(prefix: string): { kind: string; outcome: { status: number; code?: string; error?: { class: string } } }[] {
  return [...warn.mock.calls, ...error.mock.calls]
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith(`${prefix} `))
    .map((line) => {
      const [, kind, json] = /^\S+ (\w+) (.*)$/s.exec(line) ?? [];
      return { kind, outcome: JSON.parse(json) };
    });
}

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

describe.each(ROUTES)('$name', (route) => {
  const send = async (body: BodyInit, extra: Record<string, string> = {}) =>
    route.post(new NextRequest(route.url, { method: 'POST', headers: { ...(await route.headers()), ...extra }, body }));

  it.each([
    ['InvalidConversionOutputError', () => new InvalidConversionOutputError('pdf', 'docx'), 500],
    ['GraphStateCorruptError', () => new GraphStateCorruptError('record lacks a field'), 500],
    ['CpuTaskAbortedError', () => new CpuTaskAbortedError('zstd'), 500],
    ['UnknownArtifactFormatError', () => new UnknownArtifactFormatError('out.zzz'), 500],
    ['AudioResampleFaultError', () => new AudioResampleFaultError('The SIMD resampler kernel failed'), 500],
    ['OcrPreprocessFaultError', () => new OcrPreprocessFaultError('Expected 6 gray samples for a 3x2 page, got 5.'), 500],
    ['LoudnessReportMissingError', () => new LoudnessReportMissingError('The loudness measuring pass printed no report.'), 500],
    ['AvifEncoderFaultError', () => new AvifEncoderFaultError('Cannot encode the image as .avif (the AVIF encoder failed on the picture)'), 500],
    ['RawEngineRequiredError', () => new RawEngineRequiredError('native RAW decoder required'), 503],
  ])('answers %s, a fault of the server, with its status and a failure line', async (name, make, status) => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(make());

    const res = await send(pdfForm());

    expect(res.status).toBe(status);
    expect(outcomeLines(route.prefix)).toEqual([{ kind: 'failure', outcome: expect.objectContaining({ status, error: expect.objectContaining({ class: name }) }) }]);
  });

  it.each([
    ['AudioResampleFaultError', () => new AudioResampleFaultError('kernel failed at /srv/worker/secret-path')],
    ['OcrPreprocessFaultError', () => new OcrPreprocessFaultError('page at /srv/worker/secret-path is not gray')],
    ['LoudnessReportMissingError', () => new LoudnessReportMissingError('no report from /srv/worker/secret-path')],
    ['AvifEncoderFaultError', () => new AvifEncoderFaultError('encoder failed in /srv/worker/secret-path')],
  ])('answers %s with the fixed sentence of a fault, not the words of its error', async (_name, make) => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(make());

    const res = await send(pdfForm());

    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).toContain(route.faultSentence);
    expect(body).not.toContain('secret-path');
  });

  it.each([
    ['CpuTaskTimeoutError', () => new CpuTaskTimeoutError('png', 1000), 422, 'timeout'],
    ['ImportBudgetExceededError', () => new ImportBudgetExceededError('no bytes left today'), 429, 'import_budget_exceeded'],
    ['OcrLanguageUnknownError', () => new OcrLanguageUnknownError('unknown language'), 400, 'option_not_supported'],
    ['OcrTextLayerLimitError', () => new OcrTextLayerLimitError('The page has more than 50000 words.'), 400, 'input_over_limit'],
  ])('answers %s with the status and the code its class declares, and logs it as a refusal', async (name, make, status, code) => {
    vi.mocked(dispatchConversion).mockRejectedValueOnce(make());

    const res = await send(pdfForm());

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(outcomeLines(route.prefix)).toEqual([{ kind: 'refusal', outcome: expect.objectContaining({ status, code, error: { class: name } }) }]);
  });

  it('answers a body that is not multipart with 415', async () => {
    const res = await send('{}', { 'content-type': 'application/json' });

    expect(res.status).toBe(HTTP_UNSUPPORTED_MEDIA_TYPE);
  });

  it('answers a multipart body that cannot be parsed with 400', async () => {
    const res = await send('this is not multipart', { 'content-type': 'multipart/form-data; boundary=xx' });

    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(error.mock.calls).toHaveLength(0);
  });

  it('answers a client that went away while the body was read with 499', async () => {
    const client = new AbortController();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('--xx\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\nabc'));
      },
      pull() {
        client.abort();
        throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
      },
    });
    const req = new NextRequest(route.url, {
      method: 'POST',
      headers: { ...(await route.headers()), 'content-type': 'multipart/form-data; boundary=xx' },
      body,
      signal: client.signal,
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1]);

    const res = await route.post(req);

    expect(res.status).toBe(HTTP_CLIENT_CLOSED_REQUEST);
    expect(outcomeLines(route.prefix)).toEqual([{ kind: 'refusal', outcome: expect.objectContaining({ status: HTTP_CLIENT_CLOSED_REQUEST }) }]);
  });

  it('answers a target sent as a file part with 400, not a fault of the server', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(PDF)], 'report.pdf', { type: 'application/pdf' }));
    form.append('targetFormat', new File(['docx'], 'docx.txt'));

    const res = await send(form);

    expect(res.status).toBe(HTTP_BAD_REQUEST);
  });

  it.each([...route.textFields] as Array<readonly [string, string | undefined]>)(
    'answers %s sent as a file part with 400 and converts nothing',
    async (field, code) => {
    const form = pdfForm();
    const protect = JSON.stringify({ protect: { userPassword: 'user-secret', ownerPassword: 'owner-secret' } });
    form.append(field, new File([field === 'options' ? protect : 'value'], `${field}.txt`));
    vi.mocked(dispatchConversion).mockClear();

    const res = await send(form);

    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect((await res.json()).code).toBe(code);
    expect(dispatchConversion).not.toHaveBeenCalled();
  });
});
