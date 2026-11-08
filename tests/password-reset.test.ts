import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import en from '../messages/en.json';
import ko from '../messages/ko.json';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { from: string; to: string; subject: string; text: string }) => ({ messageId: 'fixture' })),
  close: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock('nodemailer', () => ({
  createTransport: (options: unknown) => {
    mail.createTransport(options);
    return { sendMail: mail.sendMail, close: mail.close };
  },
}));

import { POST as requestReset } from '../src/app/api/auth/password-reset/request/route';
import { POST as confirmReset } from '../src/app/api/auth/password-reset/confirm/route';
import { GET as resetStatus } from '../src/app/api/auth/password-reset/route';
import { issueAuthToken, resetAuthTokenMemory } from '../src/lib/auth/auth-email-token-store';
import { verifyPassword } from '../src/lib/auth/crypto';
import {
  MAIL_LINK_MAX_PER_IP,
  MAIL_LINK_MAX_PER_SUBJECT,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromRequest, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import {
  GOOD_PASSWORD,
  answersAtTheOpaqueFloor,
  freshClientIp,
  googleAccount,
  jsonPost,
  passwordAccount,
  stubMailConfig,
  stubNoMailConfig,
  tokenOfMail,
} from './helpers/auth-mail-fixtures';

const REQUEST_URL = '/api/auth/password-reset/request';
const CONFIRM_URL = '/api/auth/password-reset/confirm';
async function lastMailToken(): Promise<string> {
  await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalled());
  return tokenOfMail(mail.sendMail.mock.calls.at(-1)![0].text);
}

beforeEach(() => {
  redisUserStore.resetStore();
  resetAuthTokenMemory();
  resetLoginRateLimiterStore();
  mail.sendMail.mockClear();
  mail.createTransport.mockClear();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('password reset is off without SMTP', () => {
  it('reports itself off, and every route answers 404 without sending or storing anything', async () => {
    stubNoMailConfig();
    await passwordAccount('quiet');
    expect(await (await resetStatus()).json()).toEqual({ success: true, enabled: false });

    const asked = await requestReset(jsonPost(REQUEST_URL, { email: 'quiet@fixture.test' }));
    expect(asked.status).toBe(404);
    expect((await asked.json()).code).toBe('mail_unavailable');
    const confirmed = await confirmReset(jsonPost(CONFIRM_URL, { token: 'a'.repeat(43), password: GOOD_PASSWORD }));
    expect(confirmed.status).toBe(404);
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    ['no password', { SMTP_PASSWORD: '' }],
    ['no account', { SMTP_USER: '' }],
    ['no host', { SMTP_HOST: '' }],
    ['no public origin', { APP_ORIGIN: '' }],
    ['a port that is not one', { SMTP_PORT: '70000' }],
  ])('stays off with %s', async (_label, unset) => {
    for (const [name, value] of Object.entries(unset)) vi.stubEnv(name, value);
    expect((await (await resetStatus()).json()).enabled).toBe(false);
  });

  it('is on with the host, the account, the password and an origin', async () => {
    expect(await (await resetStatus()).json()).toEqual({ success: true, enabled: true });
  });
});

describe('the request route', () => {
  it('answers a known, an unknown, a Google-only and an unverified address with the same body, status and timing', async () => {
    await passwordAccount('known', { emailVerified: true });
    await googleAccount('googler');
    await passwordAccount('unverified');

    const responses = await answersAtTheOpaqueFloor(
      ['known', 'nobody', 'googler', 'unverified'].map((label) => () => requestReset(jsonPost(REQUEST_URL, { email: `${label}@fixture.test` })))
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(202);
      expect(bodies[index]).toEqual({ success: true });
      expect(response.headers.get('content-type')).toBe(responses[0].headers.get('content-type'));
    }

    // Only the verified password account was mailed.
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail.mock.calls[0][0].to).toBe('known@fixture.test');
  });

  it('answers a mail that cannot be sent as it answers one that was sent', async () => {
    await passwordAccount('known', { emailVerified: true });
    mail.sendMail.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNECTION' }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [response] = await answersAtTheOpaqueFloor([() => requestReset(jsonPost(REQUEST_URL, { email: 'known@fixture.test' }))]);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true });
  });

  it('sends a plain text mail whose link points at the configured origin, whatever Host the request names', async () => {
    await passwordAccount('known', { emailVerified: true });
    await requestReset(
      jsonPost(REQUEST_URL, { email: 'known@fixture.test' }, { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' } })
    );
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.text).toContain('https://convert.fixture.test/auth/reset-password#token=');
    expect(sent.text).not.toContain('evil.example');
    expect(sent.from).toBe('sender.account@fixture.test');
    expect(Object.keys(sent).sort()).toEqual(['from', 'subject', 'text', 'to']);
  });

  it('writes the mail in the language of the page, English by default', async () => {
    await passwordAccount('english', { emailVerified: true });
    await passwordAccount('korean', { emailVerified: true });
    await passwordAccount('other', { emailVerified: true });
    await Promise.all([
      requestReset(jsonPost(REQUEST_URL, { email: 'english@fixture.test' })),
      requestReset(jsonPost(REQUEST_URL, { email: 'korean@fixture.test', locale: 'ko' })),
      requestReset(jsonPost(REQUEST_URL, { email: 'other@fixture.test', locale: 'fr' })),
    ]);
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(3));
    const byRecipient = Object.fromEntries(mail.sendMail.mock.calls.map(([message]) => [message.to, message]));
    expect(byRecipient['english@fixture.test'].subject).toBe('Reset your EasyConvert password');
    expect(byRecipient['english@fixture.test'].text).toContain('works once');
    expect(byRecipient['korean@fixture.test'].subject).toContain('비밀번호');
    expect(byRecipient['korean@fixture.test'].text).toContain('https://convert.fixture.test/ko/auth/reset-password#token=');
    expect(byRecipient['korean@fixture.test'].text).toMatch(/요\.\n/);
    expect(byRecipient['other@fixture.test'].subject).toBe('Reset your EasyConvert password');
  });

  it('uses the port 587 with STARTTLS required, and a certificate check, by default', async () => {
    await passwordAccount('known', { emailVerified: true });
    await requestReset(jsonPost(REQUEST_URL, { email: 'known@fixture.test' }));
    await vi.waitFor(() => expect(mail.createTransport).toHaveBeenCalledTimes(1));
    expect(mail.createTransport.mock.calls[0][0]).toMatchObject({
      host: 'smtp.fixture.test',
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
      auth: { user: 'sender.account@fixture.test', pass: 'fixture-app-password-Zq7' },
    });
  });

  it('refuses a body that is not an email address, before any lookup', async () => {
    const response = await requestReset(jsonPost(REQUEST_URL, { email: 'not-an-address' }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_email');
  });
});

describe('the rate limits', () => {
  it(`allow ${MAIL_LINK_MAX_PER_SUBJECT} requests per address in a window and refuse the next with Retry-After, known or not`, async () => {
    await passwordAccount('known', { emailVerified: true });
    for (const label of ['known', 'nobody']) {
      const email = `${label}@fixture.test`;
      const answers = await Promise.all(Array.from({ length: MAIL_LINK_MAX_PER_SUBJECT + 1 }, () => requestReset(jsonPost(REQUEST_URL, { email }))));
      const statuses = answers.map((answer) => answer.status).sort();
      expect(statuses).toEqual([202, 202, 202, 429]);
      const refused = answers.find((answer) => answer.status === 429)!;
      expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      expect((await refused.json()).code).toBe('mail_rate_limited');
    }
  });

  it(`allow ${MAIL_LINK_MAX_PER_IP} requests per client in a window, whatever the addresses`, async () => {
    const ip = freshClientIp();
    const answers = await Promise.all(
      Array.from({ length: MAIL_LINK_MAX_PER_IP + 1 }, (_, index) => requestReset(jsonPost(REQUEST_URL, { email: `user${index}@fixture.test` }, { ip })))
    );
    expect(answers.filter((answer) => answer.status === 202)).toHaveLength(MAIL_LINK_MAX_PER_IP);
    expect(answers.filter((answer) => answer.status === 429)).toHaveLength(1);
  });

  it('bound the attempts to use a link per client', async () => {
    const ip = freshClientIp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt++) {
      statuses.push((await confirmReset(jsonPost(CONFIRM_URL, { token: 'x', password: GOOD_PASSWORD }, { ip }))).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe('the confirm route', () => {
  async function accountWithToken() {
    const record = await passwordAccount('known', { emailVerified: true });
    const token = await issueAuthToken('reset', { userId: record.id, email: record.email });
    return { record, token };
  }

  it('sets the new password, uses the token up, and ends every session of the account', async () => {
    const { record, token } = await accountWithToken();
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(redisUserStore.sanitizeUser(record))}`;
    const beforeReset = new Request('http://localhost:3000/api/auth/me', { headers: { cookie } });
    expect(await getSessionFromRequest(beforeReset)).not.toBeNull();

    const response = await confirmReset(jsonPost(CONFIRM_URL, { token, password: 'a brand new passphrase' }, { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');

    const stored = (await redisUserStore.findById(record.id))!;
    expect(await verifyPassword('a brand new passphrase', stored.passwordHash!, stored.salt!)).toBe(true);
    expect(await verifyPassword(GOOD_PASSWORD, stored.passwordHash!, stored.salt!)).toBe(false);
    expect(await getSessionFromRequest(beforeReset)).toBeNull();

    // A session made after the reset works.
    const fresh = createSessionToken(redisUserStore.sanitizeUser(stored));
    expect(await getSessionFromRequest(new Request('http://localhost:3000/', { headers: { cookie: `${SESSION_COOKIE_NAME}=${fresh}` } }))).not.toBeNull();
  });

  it('works once: the second use of a token is refused', async () => {
    const { token } = await accountWithToken();
    expect((await confirmReset(jsonPost(CONFIRM_URL, { token, password: 'first new passphrase' }))).status).toBe(200);
    const again = await confirmReset(jsonPost(CONFIRM_URL, { token, password: 'second new passphrase' }));
    expect(again.status).toBe(400);
    expect((await again.json()).code).toBe('invalid_token');
  });

  it('lets only one of two simultaneous requests with one token through', async () => {
    const { token } = await accountWithToken();
    const answers = await Promise.all([
      confirmReset(jsonPost(CONFIRM_URL, { token, password: 'first new passphrase' })),
      confirmReset(jsonPost(CONFIRM_URL, { token, password: 'second new passphrase' })),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
  });

  it('refuses a token after 10 minutes and accepts it just before', async () => {
    const { record, token } = await accountWithToken();
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = Date.now();
    vi.setSystemTime(issuedAt + 10 * 60_000 + 1_000);
    const late = await confirmReset(jsonPost(CONFIRM_URL, { token, password: 'a brand new passphrase' }));
    expect(late.status).toBe(400);
    expect((await late.json()).code).toBe('invalid_token');

    const second = await issueAuthToken('reset', { userId: record.id, email: record.email });
    vi.setSystemTime(Date.now() + 10 * 60_000 - 5_000);
    expect((await confirmReset(jsonPost(CONFIRM_URL, { token: second, password: 'a brand new passphrase' }))).status).toBe(200);
  });

  it('keeps only the newest token of an account', async () => {
    const { record, token: older } = await accountWithToken();
    const newer = await issueAuthToken('reset', { userId: record.id, email: record.email });
    expect((await confirmReset(jsonPost(CONFIRM_URL, { token: older, password: 'a brand new passphrase' }))).status).toBe(400);
    expect((await confirmReset(jsonPost(CONFIRM_URL, { token: newer, password: 'a brand new passphrase' }))).status).toBe(200);
  });

  it.each([
    ['seven characters', 'abcdefg'],
    ['1025 characters', 'a'.repeat(1025)],
    ['no password', undefined],
  ])('applies the rules of registration: %s is refused and the token is kept', async (_label, password) => {
    const { token } = await accountWithToken();
    const refused = await confirmReset(jsonPost(CONFIRM_URL, { token, password }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe('password_length');
    expect((await confirmReset(jsonPost(CONFIRM_URL, { token, password: 'a'.repeat(8) }))).status).toBe(200);
  });

  it('accepts 8 and 1024 characters', async () => {
    const { record } = await accountWithToken();
    for (const length of [8, 1024]) {
      const token = await issueAuthToken('reset', { userId: record.id, email: record.email });
      expect((await confirmReset(jsonPost(CONFIRM_URL, { token, password: 'p'.repeat(length) }))).status).toBe(200);
    }
  });

  it.each([
    ['a token of the wrong shape', 'short'],
    ['a token that was never issued', 'A'.repeat(43)],
    ['no token', undefined],
  ])('refuses %s', async (_label, token) => {
    const response = await confirmReset(jsonPost(CONFIRM_URL, { token, password: GOOD_PASSWORD }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_token');
  });

  it('does not take a verification token for a reset token', async () => {
    const record = await passwordAccount('known', { emailVerified: true });
    const token = await issueAuthToken('verify', { userId: record.id, email: record.email });
    expect((await confirmReset(jsonPost(CONFIRM_URL, { token, password: GOOD_PASSWORD }))).status).toBe(400);
  });

  it('clears the failed sign-in count of the address', async () => {
    const { record, token } = await accountWithToken();
    const { recordFailedLogin, checkLoginRateLimit } = await import('../src/lib/auth/login-rate-limiter');
    for (let attempt = 0; attempt < 5; attempt++) await recordFailedLogin(null, record.email);
    expect((await checkLoginRateLimit(null, record.email)).allowed).toBe(false);
    await confirmReset(jsonPost(CONFIRM_URL, { token, password: 'a brand new passphrase' }));
    expect((await checkLoginRateLimit(null, record.email)).allowed).toBe(true);
  });
});

describe('the messages', () => {
  const keys = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${prefix}${key}.`))
      : [prefix.slice(0, -1)];
  const wording = ['auth.forgot', 'auth.reset', 'auth.verify', 'auth.form.forgotPassword', 'dashboard.emailNotice', 'meta.passwordReset', 'errors.auth.mail_unavailable', 'errors.auth.mail_rate_limited', 'errors.auth.invalid_token'];
  const pick = (messages: unknown, path: string) => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], messages);

  it.each(wording)('has %s in English and Korean, with the same keys', (path) => {
    const english = pick(en, path);
    const korean = pick(ko, path);
    expect(english).toBeDefined();
    expect(korean).toBeDefined();
    expect(keys(korean).sort()).toEqual(keys(english).sort());
  });

  it('writes the Korean sentences of the new screens in the polite 해요 form', () => {
    const sentences = ['auth.forgot', 'auth.reset', 'auth.verify', 'dashboard.emailNotice']
      .flatMap((path) => Object.entries(pick(ko, path) as Record<string, string>))
      .filter(([key]) => ['intro', 'sent', 'done', 'noToken', 'text', 'connection'].includes(key))
      .map(([, text]) => text);
    expect(sentences.length).toBeGreaterThan(6);
    for (const sentence of sentences) expect(sentence).toMatch(/요[.…]*$/);
  });
});
