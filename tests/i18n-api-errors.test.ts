import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as fetchUrl } from '../src/app/api/fetch-url/route';
import { POST as login } from '../src/app/api/auth/login/route';
import { POST as register } from '../src/app/api/auth/register/route';
import {
  useAuthErrorWording,
  useProblemWording,
  useUrlImportErrorWording,
  type ErrorWording,
} from '../src/components/i18n/error-wording';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { hashPassword } from '../src/lib/auth/crypto';
import { concurrencyLimitResponse } from '../src/lib/queue/concurrency-limit';
import { fileSizeLimitProblem } from '../src/lib/api/file-size-limit';
import { AUTH_ERROR_CODES, URL_IMPORT_ERROR_CODES } from '../src/lib/refusal-codes';
import { PLAN_MAX_FILE_BYTES, SINGLE_REQUEST_BODY_MAX_BYTES } from '../src/lib/plan-limits';
import type { TestLocale } from './helpers/intl';
import { renderDom, visibleText } from './helpers/rendered-dom';

/**
 * A refused API call reads in the page's language. The interface words a stable `code` or a problem `type`, formats the
 * numbers the answer carries as fields, never glues the server's English `detail` into the sentence, and words any other
 * answer by its status class with the English text kept for "technical details". API callers keep the English `error`.
 */

const ENGLISH_PHRASE = /[A-Za-z]{2,}[\s,.]+[A-Za-z]{2,}/;
const HANGUL = /[가-힣]/;
const PROBLEM = 'https://api.easyconvert.io/problems/';

/** What a wording hook gives, read under the page's message provider. */
function worded<A extends unknown[]>(useWording: () => (...args: A) => ErrorWording, locale: TestLocale, ...args: A): ErrorWording {
  let result: ErrorWording | undefined;
  function Wording() {
    result = useWording()(...args);
    return createElement('p', null, result.message);
  }
  visibleText(renderDom(createElement(Wording), locale));
  if (!result) throw new Error('the wording hook did not run');
  return result;
}

function expectKorean(wording: ErrorWording, label: string): void {
  expect(wording.message, label).toMatch(HANGUL);
  expect(wording.message, label).not.toMatch(ENGLISH_PHRASE);
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
    expect(worded(useProblemWording, 'ko', body, status).message).toBe(
      '동시에 진행할 수 있는 변환 5개가 모두 진행 중입니다. 진행 중인 변환이 끝난 뒤 다시 시도하십시오.'
    );
  });

  it('words the plan limit of a file from the plan and the size the 413 names', async () => {
    const res = fileSizeLimitProblem({ id: 'user-1', tier: 'free' }, 3 * 1024 ** 3, '/api/convert');
    const { status, body } = await bodyOf(res!);
    expect(body).toMatchObject({ plan: 'free', sizeBytes: 3 * 1024 ** 3, limitBytes: PLAN_MAX_FILE_BYTES.free });
    const korean = worded(useProblemWording, 'ko', body, status);
    expectKorean(korean, 'plan limit');
    expect(korean.message).toContain('3 GiB');
    expect(korean.message).not.toContain(body.detail as string);
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
      expect(korean.message, String(body.type)).toContain(number);
    }
  });

  it('words an answer it does not know by its status class, keeping the English text of a refusal and never of a server failure', () => {
    const unknown = { type: `${PROBLEM}byos-invalid-endpoint`, detail: 'The endpoint is not reachable.' };
    const korean = worded(useProblemWording, 'ko', unknown, 400);
    expectKorean(korean, 'unknown type');
    expect(korean.technical).toBe('The endpoint is not reachable.');
    expect(worded(useProblemWording, 'ko', { error: 'spawn /usr/bin/magick ENOENT' }, 500).technical).toBeUndefined();
    expect(worded(useProblemWording, 'ko', { error: 'Database offline.' }, 500).message).not.toBe(korean.message);
  });

  it('keeps the English text of a refusal of a known type under technical details', () => {
    const quota = { type: `${PROBLEM}quota-exceeded`, detail: 'The daily limit of 50 conversions is used up.', dailyLimit: 50 };
    expect(worded(useProblemWording, 'ko', quota, 429).technical).toBe(quota.detail);
    const plan = { type: `${PROBLEM}payload-too-large`, detail: 'File size 3 GiB exceeds the 1 GiB limit.', plan: 'free', sizeBytes: 3 * 1024 ** 3 };
    expect(worded(useProblemWording, 'ko', plan, 413).technical).toBe(plan.detail);
    expect(worded(useProblemWording, 'ko', { type: `${PROBLEM}service-unavailable`, detail: 'Redis at /var/run/redis.sock is down.' }, 503).technical).toBeUndefined();
  });
});

describe('link import refusals', () => {
  async function urlImportAnswer(url: unknown) {
    return bodyOf(await fetchUrl(jsonRequest('/api/fetch-url', { url })));
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

  it('words every refusal code in Korean, and the remote status as a number', () => {
    for (const code of URL_IMPORT_ERROR_CODES) {
      expectKorean(worded(useUrlImportErrorWording, 'ko', { code, error: 'English text', status: 404 }, 400), code);
    }
    expect(worded(useUrlImportErrorWording, 'ko', { code: 'remote_error', remoteStatus: 404, error: 'x' }, 400).message).toBe(
      '링크의 사이트가 파일 대신 HTTP 404 응답을 보냈습니다. 브라우저에서 링크가 파일을 여는지 확인하십시오.'
    );
  });

  it('words an answer without a known code by its status class, keeping the text of a refusal only', () => {
    const korean = worded(useUrlImportErrorWording, 'ko', { error: 'Upstream said no.' }, 400);
    expectKorean(korean, 'unknown');
    expect(korean.technical).toBe('Upstream said no.');
    expect(worded(useUrlImportErrorWording, 'ko', { error: 'Upstream said no.' }, 502).technical).toBeUndefined();
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
    expect(korean.message).toContain(new Intl.NumberFormat('ko').format(seconds));
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
    expect(untyped.technical).toBe('Email and password are required strings.');
    expect(untyped.message).not.toBe(worded(useAuthErrorWording, 'ko', { code: 'missing_fields' }, 400).message);
  });
});
