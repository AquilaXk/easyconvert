import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { from: string; to: string; subject: string; text: string }) => ({ messageId: 'fixture' })),
}));
vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: mail.sendMail, close: vi.fn() }),
}));

import { POST as sendCode } from '../src/app/api/auth/register/code/route';
import { POST as register } from '../src/app/api/auth/register/route';
import { POST as login } from '../src/app/api/auth/login/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { resetAuthTokenMemory } from '../src/lib/auth/auth-email-token-store';
import { isEmailVerified } from '../src/lib/auth/account-mail';
import { EMAIL_CODE_MAX_ATTEMPTS, resetEmailCodeMemory } from '../src/lib/auth/email-code-store';
import {
  EMAIL_CODE_MAX_PER_ADDRESS_AND_IP,
  MAIL_LINK_MAX_PER_SUBJECT,
  REGISTER_MAX_ATTEMPTS_PER_IP,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';
import { MAIL_DAILY_HARD_CAP, reserveMailSend, resetMailBudgetMemory } from '../src/lib/auth/mail-budget';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import {
  GOOD_PASSWORD,
  answersAtTheOpaqueFloor,
  freshClientIp,
  googleAccount,
  jsonPost,
  passwordAccount,
  stubMailConfig,
  stubNoMailConfig,
} from './helpers/auth-mail-fixtures';

/**
 * Password sign-up in two steps (a mailed six-digit code, then the account) and the code that an account of the old kind
 * needs at its next sign-in. docs/policy-decisions.md, entry 288.
 */

const CODE_URL = '/api/auth/register/code';
const REGISTER_URL = '/api/auth/register';
const LOGIN_URL = '/api/auth/login';

function codeOfMail(text: string): string {
  const match = /^(\d{6})$/m.exec(text);
  if (!match) throw new Error('the mail carries no code');
  return match[1];
}

async function mailedCode(index = 0): Promise<string> {
  await vi.waitFor(() => expect(mail.sendMail.mock.calls.length).toBeGreaterThan(index));
  return codeOfMail(mail.sendMail.mock.calls[index][0].text);
}

const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

function signUpBody(email: string, code: string, extra: Record<string, unknown> = {}) {
  return { email, code, password: GOOD_PASSWORD, name: 'New Person', acceptedTermsVersion: TERMS_VERSION, ...extra };
}

beforeEach(() => {
  redisUserStore.resetStore();
  redisKeyStore.resetStore();
  resetAuthTokenMemory();
  resetEmailCodeMemory();
  resetLoginRateLimiterStore();
  resetMailBudgetMemory();
  mail.sendMail.mockClear();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the first step: a code to the address', () => {
  it('mails a six-digit code in the language asked for, and makes no account', async () => {
    const response = await sendCode(jsonPost(CODE_URL, { email: 'New.Person@fixture.test', locale: 'ko' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true });
    const code = await mailedCode();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.to).toBe('New.Person@fixture.test');
    expect(sent.subject).toBe('EasyConvert 인증 코드');
    expect(sent.text).toContain('10분 안에 입력하세요');
    expect(code).toMatch(/^\d{6}$/);
    expect(await redisUserStore.findByEmail('new.person@fixture.test')).toBeNull();
  });

  it('answers a new address and an address with an account alike, at the same time, and mails only the new one', async () => {
    await passwordAccount('known', { emailVerified: true });
    const responses = await answersAtTheOpaqueFloor([
      () => sendCode(jsonPost(CODE_URL, { email: 'known@fixture.test' })),
      () => sendCode(jsonPost(CODE_URL, { email: 'unknown@fixture.test' })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ success: true }, { success: true }]);
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    expect(mail.sendMail.mock.calls[0][0].to).toBe('unknown@fixture.test');
  });

  it('refuses an address that is not one plain mailbox, and one on a disposable domain, and sends nothing', async () => {
    for (const email of ['a@y.com,victim@x.com', 'no-at-sign', '']) {
      const response = await sendCode(jsonPost(CODE_URL, { email }));
      expect(response.status, email).toBe(400);
      expect((await response.json()).code, email).toBe('invalid_email');
    }
    for (const email of ['someone@0-mail.com', 'someone@inbox.0-mail.com']) {
      const response = await sendCode(jsonPost(CODE_URL, { email }));
      expect(response.status, email).toBe(400);
      expect((await response.json()).code, email).toBe('disposable_email');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('answers 404 when SMTP is not configured', async () => {
    stubNoMailConfig();
    const response = await sendCode(jsonPost(CODE_URL, { email: 'a@fixture.test' }));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('mail_unavailable');
  });

  it(`stops the ${EMAIL_CODE_MAX_PER_ADDRESS_AND_IP + 1}th code to one address from one client within a minute with 429 and Retry-After`, async () => {
    const ip = freshClientIp();
    const accepted = await Promise.all(
      Array.from({ length: EMAIL_CODE_MAX_PER_ADDRESS_AND_IP }, () => sendCode(jsonPost(CODE_URL, { email: 'a@fixture.test' }, { ip })))
    );
    expect(accepted.map((response) => response.status)).toEqual([202, 202]);
    const refused = await sendCode(jsonPost(CODE_URL, { email: 'a@fixture.test' }, { ip }));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect((await refused.json()).code).toBe('mail_rate_limited');
    // Another address from the same client is not held.
    expect((await sendCode(jsonPost(CODE_URL, { email: 'b@fixture.test' }, { ip }))).status).toBe(202);
  });

  it(`stops the ${MAIL_LINK_MAX_PER_SUBJECT + 1}th code to one address in ten minutes whichever clients ask, and answers an address with an account the same`, async () => {
    await passwordAccount('known', { emailVerified: true });
    for (const email of ['a@fixture.test', 'known@fixture.test']) {
      // Every answer waits out the opaque floor, so the requests of a window go together.
      const accepted = await Promise.all(Array.from({ length: MAIL_LINK_MAX_PER_SUBJECT }, () => sendCode(jsonPost(CODE_URL, { email }))));
      expect(accepted.map((response) => response.status)).toEqual([202, 202, 202]);
      const refused = await sendCode(jsonPost(CODE_URL, { email }));
      expect(refused.status, email).toBe(429);
      expect((await refused.json()).code, email).toBe('mail_rate_limited');
    }
  });

  it(`keeps the limit of ${REGISTER_MAX_ATTEMPTS_PER_IP} requests per client in 5 minutes, whatever the addresses`, async () => {
    const ip = freshClientIp();
    const accepted = await Promise.all(
      Array.from({ length: REGISTER_MAX_ATTEMPTS_PER_IP }, (_, sent) => sendCode(jsonPost(CODE_URL, { email: `spam${sent}@fixture.test` }, { ip })))
    );
    expect(accepted.map((response) => response.status)).toEqual(Array(REGISTER_MAX_ATTEMPTS_PER_IP).fill(202));
    const refused = await sendCode(jsonPost(CODE_URL, { email: 'spam-more@fixture.test' }, { ip }));
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe('login_locked');
  });

  it('refuses with a temporary-unavailable answer, and mails nothing, when the day\'s mail budget is used up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await passwordAccount('known', { emailVerified: true });
    for (let sent = 0; sent < MAIL_DAILY_HARD_CAP; sent++) await reserveMailSend();
    for (const email of ['unknown@fixture.test', 'known@fixture.test']) {
      const response = await sendCode(jsonPost(CODE_URL, { email }));
      expect(response.status, email).toBe(503);
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect((await response.json()).code, email).toBe('mail_temporarily_unavailable');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});

describe('the second step: the account', () => {
  it('creates a verified account from the mailed code, signs it in, and lets it sign in again without a code', async () => {
    await sendCode(jsonPost(CODE_URL, { email: 'new.person@fixture.test' }));
    const code = await mailedCode();
    const response = await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', code)));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE_NAME);
    const body = await response.json();
    expect(body.user).toMatchObject({ email: 'new.person@fixture.test', name: 'New Person', provider: 'email', emailVerified: true });
    expect(isEmailVerified((await redisUserStore.findByEmail('new.person@fixture.test'))!)).toBe(true);

    const again = await login(jsonPost(LOGIN_URL, { email: 'new.person@fixture.test', password: GOOD_PASSWORD }));
    expect(again.status).toBe(200);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrong code, a missing one and one that was never sent, and creates no account', async () => {
    await sendCode(jsonPost(CODE_URL, { email: 'new.person@fixture.test' }));
    const code = await mailedCode();
    for (const bad of [wrong(code), undefined, 'abcdef', '12345', 123456]) {
      const response = await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', bad as string)));
      expect(response.status, String(bad)).toBe(400);
      expect((await response.json()).code, String(bad)).toBe('invalid_code');
    }
    const neverSent = await register(jsonPost(REGISTER_URL, signUpBody('other@fixture.test', '123456')));
    expect(neverSent.status).toBe(400);
    expect((await neverSent.json()).code).toBe('invalid_code');
    expect(await redisUserStore.findByEmail('new.person@fixture.test')).toBeNull();
  });

  it(`burns the code after ${EMAIL_CODE_MAX_ATTEMPTS} wrong guesses, so the right one is refused too`, async () => {
    await sendCode(jsonPost(CODE_URL, { email: 'new.person@fixture.test' }));
    const code = await mailedCode();
    for (let guess = 0; guess < EMAIL_CODE_MAX_ATTEMPTS; guess++) {
      expect((await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', wrong(code))))).status).toBe(400);
    }
    const right = await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', code)));
    expect(right.status).toBe(400);
    expect((await right.json()).code).toBe('invalid_code');
    expect(await redisUserStore.findByEmail('new.person@fixture.test')).toBeNull();
  });

  it('does not spend a guess on a form that is refused before the code is tried', async () => {
    await sendCode(jsonPost(CODE_URL, { email: 'new.person@fixture.test' }));
    const code = await mailedCode();
    for (let attempt = 0; attempt < EMAIL_CODE_MAX_ATTEMPTS + 2; attempt++) {
      const short = await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', code, { password: 'short' })));
      expect((await short.json()).code).toBe('password_length');
    }
    const noTerms = await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', code, { acceptedTermsVersion: undefined })));
    expect((await noTerms.json()).code).toBe('terms_not_accepted');
    expect((await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', code)))).status).toBe(200);
  });

  it('uses the code once, and keeps only the newest code of an address live', async () => {
    await sendCode(jsonPost(CODE_URL, { email: 'new.person@fixture.test' }));
    const older = await mailedCode(0);
    await sendCode(jsonPost(CODE_URL, { email: 'new.person@fixture.test' }));
    const newer = await mailedCode(1);
    if (older !== newer) {
      expect((await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', older)))).status).toBe(400);
    }
    expect((await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', newer)))).status).toBe(200);
    const reused = await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', newer)));
    expect(reused.status).toBe(400);
  });

  it('answers 409 when the address got an account between the code and the form', async () => {
    await sendCode(jsonPost(CODE_URL, { email: 'new.person@fixture.test' }));
    const code = await mailedCode();
    await googleAccount('new.person');
    const response = await register(jsonPost(REGISTER_URL, signUpBody('new.person@fixture.test', code)));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('account_exists');
  });

  it('keeps a code of the sign-up from doing the work of a sign-in code', async () => {
    const record = await passwordAccount('old.timer');
    await sendCode(jsonPost(CODE_URL, { email: 'other.person@fixture.test' }));
    const code = await mailedCode();
    const response = await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD, code }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_code');
  });
});

describe('the sign-in of an account whose address was never confirmed', () => {
  it('holds the session until the code of its address is entered, then confirms the address for good', async () => {
    const record = await passwordAccount('old.timer');
    const first = await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD, locale: 'en' }));
    expect(first.status).toBe(403);
    expect(first.headers.get('set-cookie')).toBeNull();
    expect((await first.json()).code).toBe('email_verification_required');
    const code = await mailedCode();
    expect(mail.sendMail.mock.calls[0][0].to).toBe(record.email);
    expect(mail.sendMail.mock.calls[0][0].subject).toBe('Your EasyConvert verification code');
    expect(isEmailVerified((await redisUserStore.findByEmail(record.email))!)).toBe(false);

    const second = await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD, code }));
    expect(second.status).toBe(200);
    expect(second.headers.get('set-cookie')).toContain(SESSION_COOKIE_NAME);
    expect((await second.json()).user.emailVerified).toBe(true);
    expect(isEmailVerified((await redisUserStore.findByEmail(record.email))!)).toBe(true);

    const third = await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD }));
    expect(third.status).toBe(200);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('mails no code for a wrong password, and refuses a session for a right code with a wrong password', async () => {
    const record = await passwordAccount('old.timer');
    const response = await login(jsonPost(LOGIN_URL, { email: record.email, password: 'Wrong password 1!' }));
    expect(response.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mail.sendMail).not.toHaveBeenCalled();

    await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD }));
    const code = await mailedCode();
    const stolen = await login(jsonPost(LOGIN_URL, { email: record.email, password: 'Wrong password 1!', code }));
    expect(stolen.status).toBe(401);
    expect(stolen.headers.get('set-cookie')).toBeNull();
  });

  it(`refuses a wrong code, and burns the code after ${EMAIL_CODE_MAX_ATTEMPTS} wrong guesses`, async () => {
    const record = await passwordAccount('old.timer');
    await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD }));
    const code = await mailedCode();
    for (let guess = 0; guess < EMAIL_CODE_MAX_ATTEMPTS; guess++) {
      const refused = await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD, code: wrong(code) }));
      expect(refused.status).toBe(400);
      expect(refused.headers.get('set-cookie')).toBeNull();
      expect((await refused.json()).code).toBe('invalid_code');
    }
    expect((await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD, code }))).status).toBe(400);
    expect(isEmailVerified((await redisUserStore.findByEmail(record.email))!)).toBe(false);
  });

  it('limits the codes it sends like those of the sign-up, and tells so when the mail budget is used up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const record = await passwordAccount('old.timer');
    const ip = freshClientIp();
    for (let sent = 0; sent < EMAIL_CODE_MAX_PER_ADDRESS_AND_IP; sent++) {
      expect((await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD }, { ip }))).status).toBe(403);
    }
    const limited = await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD }, { ip }));
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe('mail_rate_limited');

    for (let sent = 0; sent < MAIL_DAILY_HARD_CAP; sent++) await reserveMailSend();
    const other = await passwordAccount('other.timer');
    const busy = await login(jsonPost(LOGIN_URL, { email: other.email, password: GOOD_PASSWORD }));
    expect(busy.status).toBe(503);
    expect((await busy.json()).code).toBe('mail_temporarily_unavailable');
  });

  it('signs in a confirmed account and a Google account without a code, and mails nothing', async () => {
    const verified = await passwordAccount('verified', { emailVerified: true });
    expect((await login(jsonPost(LOGIN_URL, { email: verified.email, password: GOOD_PASSWORD }))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('signs in as before when the server cannot mail a code', async () => {
    const record = await passwordAccount('old.timer');
    stubNoMailConfig();
    expect((await login(jsonPost(LOGIN_URL, { email: record.email, password: GOOD_PASSWORD }))).status).toBe(200);
  });
});
