import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as fetchUrl } from '../src/app/api/fetch-url/route';
import { POST as login } from '../src/app/api/auth/login/route';
import { POST as register } from '../src/app/api/auth/register/route';
import {
  SINGLE_CAUSE_STATUS_PROBLEMS,
  useAuthErrorWording,
  useConversionFailureWording,
  useProblemWording,
  useUrlImportErrorWording,
} from '../src/components/i18n/error-wording';
import ConversionQueue from '../src/components/ConversionQueue';
import type { ConversionFailure } from '../src/lib/conversion-failure';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { hashPassword } from '../src/lib/auth/crypto';
import { concurrencyLimitResponse } from '../src/lib/queue/concurrency-limit';
import { fileSizeLimitProblem } from '../src/lib/api/file-size-limit';
import { uploadBudgetRefusalResponse } from '../src/lib/api/upload-budget-response';
import { AUTH_ERROR_CODES, URL_IMPORT_ERROR_CODES } from '../src/lib/refusal-codes';
import { PLAN_MAX_FILE_BYTES, SINGLE_REQUEST_BODY_MAX_BYTES } from '../src/lib/plan-limits';
import type { TestLocale } from './helpers/intl';
import { renderDom, select, visibleText } from './helpers/rendered-dom';

/**
 * A refused API call reads in the page's language. The interface words a stable `code` or a problem `type`, formats the
 * numbers the answer carries as fields, never shows the server's English `detail`, and words any other answer by its
 * status class. API callers keep the English `error`.
 */

const ENGLISH_PHRASE = /[A-Za-z]{2,}[\s,.]+[A-Za-z]{2,}/;
const HANGUL = /[가-힣]/;
/** The name of the protocol, which no sentence of the interface carries. */
const HTTP_STATUS = /HTTP/;
const PROBLEM = 'https://api.easyconvert.io/problems/';

/** What a wording hook gives, read under the page's message provider. */
function worded<A extends unknown[]>(useWording: () => (...args: A) => string, locale: TestLocale, ...args: A): string {
  let result: string | undefined;
  function Wording() {
    result = useWording()(...args);
    return createElement('p', null, result);
  }
  visibleText(renderDom(createElement(Wording), locale));
  if (!result) throw new Error('the wording hook did not run');
  return result;
}

function expectKorean(wording: string, label: string): void {
  expect(wording, label).toMatch(HANGUL);
  expect(wording, label).not.toMatch(ENGLISH_PHRASE);
  expect(wording, label).not.toMatch(HTTP_STATUS);
}

async function bodyOf(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('typed problems carry their numbers as fields, worded per locale', () => {
  it('words the concurrency limit with its number and no English sentence', async () => {
    const { status, body } = await bodyOf(concurrencyLimitResponse(5, '/api/convert'));
    expect(status).toBe(429);
    expect(worded(useProblemWording, 'ko', body, status)).toBe('동시에 진행할 수 있는 변환은 5개예요. 하나가 끝난 뒤 다시 시도해 주세요.');
  });

  it('words the plan limit of a file from the plan and the size the 413 names', async () => {
    const res = fileSizeLimitProblem({ id: 'user-1', tier: 'free' }, 3 * 1024 ** 3, '/api/convert');
    const { status, body } = await bodyOf(res!);
    expect(body).toMatchObject({ plan: 'free', sizeBytes: 3 * 1024 ** 3, limitBytes: PLAN_MAX_FILE_BYTES.free });
    const korean = worded(useProblemWording, 'ko', body, status);
    expectKorean(korean, 'plan limit');
    expect(korean).toContain('3 GiB');
    expect(korean).not.toContain(body.detail as string);
  });

  it('words the daily quota, the upload budget and the request size from their fields', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: `${PROBLEM}quota-exceeded`, detail: 'The daily limit of 50 conversions is used up. It resets at midnight UTC.', dailyLimit: 50 }, '50'],
      [{ type: `${PROBLEM}upload-budget-exceeded`, detail: 'Up to 3 uploads may be open at once without an account.', refusal: 'open-uploads', limit: 3 }, '3'],
      [{ type: `${PROBLEM}upload-budget-exceeded`, detail: 'Without an account, uploads may total 2 GiB a day.', refusal: 'daily-bytes', limitBytes: 2 * 1024 ** 3 }, '2 GiB'],
      [{ type: `${PROBLEM}payload-too-large`, detail: 'The request body is too large.', maxRequestBytes: SINGLE_REQUEST_BODY_MAX_BYTES }, `${SINGLE_REQUEST_BODY_MAX_BYTES / 2 ** 20} MiB`],
    ];
    for (const [body, number] of cases) {
      const korean = worded(useProblemWording, 'ko', body, 429);
      expectKorean(korean, String(body.type));
      expect(korean, String(body.type)).toContain(number);
    }
  });

  it("words an account's spent link import budget with its plan's allowance, not the anonymous one", async () => {
    const { status, body } = await bodyOf(uploadBudgetRefusalResponse('daily-bytes', '/api/fetch-url', 'pro'));
    expect(body).toMatchObject({ refusal: 'daily-bytes', limitBytes: 10 * 1024 ** 3, plan: 'pro' });

    const korean = worded(useProblemWording, 'ko', body, status);
    expect(korean).toContain('10 GiB');
    expect(korean).toContain('링크 가져오기');
    expect(korean).not.toContain('계정 없이');
  });

  it('words an answer it does not know by its status class, and never shows the server text of either', () => {
    const unknown = { type: `${PROBLEM}retired-problem`, detail: 'The endpoint is not reachable.' };
    const korean = worded(useProblemWording, 'ko', unknown, 400);
    expectKorean(korean, 'unknown type');
    expect(korean).not.toContain(unknown.detail);
    const failure = worded(useProblemWording, 'ko', { error: 'spawn /usr/bin/magick ENOENT' }, 500);
    expectKorean(failure, 'server failure');
    expect(failure).not.toContain('magick');
    expect(failure).not.toBe(korean);
  });

  const useStatusWording = () => useProblemWording(SINGLE_CAUSE_STATUS_PROBLEMS);
  const UNTYPED = { success: false, error: 'File record not found or not owned by user.' };
  const ACTION = '파일을 지우지 못했어요.';

  it.each([
    [401, '계속하려면 로그인해 주세요.'],
    [403, '이 계정으로는 할 수 없는 작업이에요.'],
    [404, '찾는 항목이 더 이상 없어요.'],
    [429, '짧은 시간에 요청이 너무 많았어요. 잠시 후 다시 시도해 주세요.'],
    [503, '서비스를 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.'],
  ])('words an answer without a problem type by the one cause its %i names, never by the server text', (status, sentence) => {
    expect(worded(useStatusWording, 'ko', UNTYPED, status, ACTION)).toBe(sentence);
  });

  it.each([400, 409, 413, 415, 422, 500, 502, 504])('words an answer without a problem type and a %i by the sentence of the action that failed', (status) => {
    expect(worded(useStatusWording, 'ko', UNTYPED, status, ACTION)).toBe(ACTION);
  });

  it('words an answer without a problem type by the action alone when the caller gives no status map', () => {
    for (const status of [401, 403, 404, 429, 503]) expect(worded(useProblemWording, 'ko', UNTYPED, status, ACTION), String(status)).toBe(ACTION);
  });

  const NGINX_BURST = { success: false, error: 'Too many requests' };
  const RATE_LIMITED_KO = '짧은 시간에 요청이 너무 많았어요. 잠시 후 다시 시도해 주세요.';

  it('reads the nginx burst limit (an untyped 429) as a short wait on the queue, not as the daily limit', () => {
    const failure: ConversionFailure = { code: 'server', problem: { ...NGINX_BURST, status: 429 } };
    expect(worded(useConversionFailureWording, 'ko', failure)).toBe(RATE_LIMITED_KO);
    expect(worded(useConversionFailureWording, 'en', failure)).toBe('Too many requests in a short time. Wait a moment and try again.');
  });

  it('reads the nginx burst limit as a short wait on a link import', () => {
    expect(worded(useUrlImportErrorWording, 'ko', NGINX_BURST, 429)).toBe(RATE_LIMITED_KO);
  });

  it('words a ZIP of the results that could not be built in the queue footer, in both languages', () => {
    const alert = (locale: TestLocale) => {
      const noop = () => undefined;
      const queue = renderDom(createElement(ConversionQueue, {
        items: [], onRemoveItem: noop, onClearAll: noop, onUpdateTargetFormat: noop, onUpdateOptions: noop, onConvertAll: noop,
        onConvertSingle: noop, onAddMoreFiles: noop, onDownloadAllZip: noop, isConverting: false, zipError: true,
      }), locale);
      return select(queue, 'p', 'role', 'alert').map(visibleText);
    };
    expect(alert('ko')).toEqual(['ZIP 파일을 만들지 못했어요. 다시 시도해 주세요.']);
    expect(alert('en')).toEqual(['Could not build the ZIP archive.']);
  });

  it('words a refusal of a known type by its sentence, not by the server text', () => {
    const quota = { type: `${PROBLEM}quota-exceeded`, detail: 'The daily limit of 50 conversions is used up.', dailyLimit: 50 };
    expect(worded(useProblemWording, 'ko', quota, 429)).toBe('오늘 변환 한도 50회를 모두 썼어요. 내일 다시 시도해 주세요.');
    const plan = { type: `${PROBLEM}payload-too-large`, detail: 'File size 3 GiB exceeds the 1 GiB limit.', plan: 'free', sizeBytes: 3 * 1024 ** 3 };
    expect(worded(useProblemWording, 'ko', plan, 413)).not.toContain(plan.detail);
    const down = { type: `${PROBLEM}service-unavailable`, detail: 'Redis at /var/run/redis.sock is down.' };
    expect(worded(useProblemWording, 'ko', down, 503)).not.toContain('redis');
  });

  it('words a refusal that names no known type by the sentence of the action that failed', () => {
    const conflict = { type: `${PROBLEM}conflict`, status: 409, detail: 'The file is still being written and cannot be deleted yet.' };
    expect(worded(useProblemWording, 'ko', conflict, 409, '파일을 지우지 못했어요.')).toBe('파일을 지우지 못했어요.');
  });
});

describe('link import refusals', () => {
  // A visitor a declared proxy attributes: one no proxy attributes is refused every import, as every upload.
  const VISITOR = { 'x-forwarded-for': '203.0.113.77' };

  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function urlImportAnswer(url: unknown) {
    return bodyOf(await fetchUrl(jsonRequest('/api/fetch-url', { url }, VISITOR)));
  }

  it('names each refusal with a stable code and keeps the English error for API callers', async () => {
    const answers = await Promise.all([undefined, 'not-a-valid-url', 'file:///etc/passwd', 'http://127.0.0.1/'].map(urlImportAnswer));
    expect(answers.map(({ status, body }) => [status, body.code])).toEqual([
      [400, 'url_required'],
      [400, 'invalid_url'],
      [400, 'unsupported_scheme'],
      [403, 'address_blocked'],
    ]);
    for (const { body } of answers) expect(typeof body.error).toBe('string');
  });

  it.each([
    ['malformed JSON', '{"url":'],
    ['an empty body', ''],
    ['JSON null', 'null'],
    ['a JSON array', '["https://example.com/a.png"]'],
  ])('answers %s 400 with the code invalid_json, and logs nothing', async (_, body) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body: answer } = await bodyOf(await fetchUrl(jsonRequest('/api/fetch-url', body, VISITOR)));
    expect({ status, code: answer.code }).toEqual({ status: 400, code: 'invalid_json' });
    expect(logged).not.toHaveBeenCalled();
  });

  it('words every refusal code in Korean, with no status code', () => {
    for (const code of URL_IMPORT_ERROR_CODES) {
      expectKorean(worded(useUrlImportErrorWording, 'ko', { code, error: 'English text', status: 404 }, 400), code);
    }
    expect(worded(useUrlImportErrorWording, 'ko', { code: 'remote_error', remoteStatus: 404, error: 'x' }, 400)).toBe(
      '링크의 사이트가 파일을 보내 주지 않았어요. 브라우저에서 링크가 파일을 여는지 확인해 주세요.'
    );
  });

  it('words an answer without a known code by its status, never with the server text', () => {
    const korean = worded(useUrlImportErrorWording, 'ko', { error: 'Upstream said no.' }, 400);
    expectKorean(korean, 'unknown');
    expect(korean).toBe('요청을 처리하지 못했어요. 파일과 설정을 확인한 뒤 다시 시도해 주세요.');
    expectKorean(worded(useUrlImportErrorWording, 'ko', { error: 'Upstream said no.' }, 502), 'server failure');
  });
});

describe('sign-in refusals are worded by their code', () => {
  beforeEach(() => {
    resetLoginRateLimiterStore();
    vi.stubEnv('TRUSTED_PROXIES', '');
    vi.stubEnv('TRUSTED_CDN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('locks a sign-in after repeated wrong passwords and says so in Korean with the seconds', async () => {
    const email = `lockout_${Date.now()}@i18n.test`;
    const { hash, salt } = await hashPassword('RightPassword!1');
    await redisUserStore.createUser({ email, name: 'lockout', tier: 'free', provider: 'email', passwordHash: hash, salt });
    let answer = await bodyOf(await login(jsonRequest('/api/auth/login', { email, password: 'WrongPassword!' })));
    for (let attempt = 1; attempt < 11 && answer.status === 401; attempt++) {
      expect(answer.body.code).toBe('invalid_credentials');
      answer = await bodyOf(await login(jsonRequest('/api/auth/login', { email, password: 'WrongPassword!' })));
    }
    expect(answer.status).toBe(429);
    expect(answer.body).toMatchObject({ type: `${PROBLEM}rate-limited`, code: 'login_locked' });
    const seconds = answer.body.retryAfterSeconds as number;
    expect(seconds).toBeGreaterThan(0);
    const korean = worded(useAuthErrorWording, 'ko', answer.body, answer.status);
    expectKorean(korean, 'lockout');
    expect(korean).toContain(new Intl.NumberFormat('ko').format(seconds));
  });

  it('gives each cause of a refused sign-in or sign-up its own code', async () => {
    const existing = `exists_${Date.now()}@i18n.test`;
    await redisUserStore.createUser({ email: existing, name: 'exists', tier: 'free', provider: 'email' });
    const answers = [
      await bodyOf(await login(jsonRequest('/api/auth/login', '{not json'))),
      await bodyOf(await login(jsonRequest('/api/auth/login', { email: 'a@b.test' }))),
      await bodyOf(await register(jsonRequest('/api/auth/register', '{not json'))),
      await bodyOf(await register(jsonRequest('/api/auth/register', { email: 'no-at-sign', password: 'LongEnough1' }))),
      await bodyOf(await register(jsonRequest('/api/auth/register', { email: 'new@i18n.test', password: 'short' }))),
      await bodyOf(await register(jsonRequest('/api/auth/register', { email: existing, password: 'LongEnough1' }))),
    ];
    expect(answers.map(({ status, body }) => [status, body.code])).toEqual([
      [400, 'invalid_json'],
      [400, 'missing_fields'],
      [400, 'invalid_json'],
      [400, 'invalid_email'],
      [400, 'password_length'],
      [409, 'account_exists'],
    ]);
    for (const { status, body } of answers) {
      expect(typeof body.error).toBe('string');
      expectKorean(worded(useAuthErrorWording, 'ko', body, status), String(body.code));
    }
  });

  it.each([
    ['malformed JSON', '{"email":'],
    ['an empty body', ''],
    ['JSON null', 'null'],
    ['a JSON array', '["a@b.test", "LongEnough1"]'],
  ])('answers sign-in and sign-up %s 400 with the code invalid_json, and logs nothing', async (_, body) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answers = [
      await bodyOf(await login(jsonRequest('/api/auth/login', body))),
      await bodyOf(await register(jsonRequest('/api/auth/register', body))),
    ];
    expect(answers.map(({ status, body: answer }) => [status, answer.code])).toEqual([
      [400, 'invalid_json'],
      [400, 'invalid_json'],
    ]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('names an undeterminable client address and a missing proxy configuration', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const malformed = await bodyOf(await login(jsonRequest('/api/auth/login', { email: 'a@b.test', password: 'x' }, { 'x-forwarded-for': 'not-an-address' })));
    vi.stubEnv('TRUSTED_PROXIES', 'not-a-cidr');
    const unconfigured = await bodyOf(await login(jsonRequest('/api/auth/login', { email: 'a@b.test', password: 'x' })));
    expect([malformed.status, malformed.body.code]).toEqual([400, 'client_address_unknown']);
    expect([unconfigured.status, unconfigured.body.code]).toEqual([503, 'client_ip_unconfigured']);
  });

  it('words every sign-in code in Korean and never by the status alone', () => {
    for (const code of AUTH_ERROR_CODES) {
      expectKorean(worded(useAuthErrorWording, 'ko', { code, error: 'English text.', retryAfterSeconds: 30 }, 400), code);
    }
    const untyped = worded(useAuthErrorWording, 'ko', { error: 'Email and password are required strings.' }, 400);
    expect(untyped).not.toContain('Email and password');
    expect(untyped).not.toBe(worded(useAuthErrorWording, 'ko', { code: 'missing_fields' }, 400));
    for (const status of [400, 401, 403, 429, 503]) {
      expect(worded(useAuthErrorWording, 'ko', { error: 'Rejected.' }, status), String(status)).toBe('로그인하지 못했어요. 다시 시도해 주세요.');
    }
  });
});

describe('a name or code outside the closed lists reads as its status class', () => {
  const NOT_CODES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

  it.each(NOT_CODES)('words the problem type %s as a refusal', (name) => {
    expect(worded(useProblemWording, 'en', { type: `${PROBLEM}${name}`, detail: 'x' }, 400)).toBe(worded(useProblemWording, 'en', { type: `${PROBLEM}retired-problem` }, 400));
  });

  it.each(NOT_CODES)('words the link import code %s by its status class', (code) => {
    expect(worded(useUrlImportErrorWording, 'en', { code, remoteStatus: 404, error: 'x' }, 400)).toBe(worded(useUrlImportErrorWording, 'en', { error: 'x' }, 400));
  });

  it.each([...NOT_CODES, 'failed'])('words the sign-in code %s as a failed sign-in', (code) => {
    expect(worded(useAuthErrorWording, 'en', { code, error: 'x' }, 400)).toBe(worded(useAuthErrorWording, 'en', { error: 'x' }, 400));
  });

  it.each(NOT_CODES)('words the conversion code %s as a failed job or a refusal', (code) => {
    const jobFailed: ConversionFailure = { code: 'jobFailed', refusalCode: code };
    const refused: ConversionFailure = { code: 'server', problem: { status: 400, code, error: 'x' } };
    expect(worded(useConversionFailureWording, 'en', jobFailed)).toBe(worded(useConversionFailureWording, 'en', { code: 'jobFailed' }));
    expect(worded(useConversionFailureWording, 'en', refused)).toBe(worded(useProblemWording, 'en', {}, 400));
  });
});
