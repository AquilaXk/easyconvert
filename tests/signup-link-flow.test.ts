import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { from: string; to: string; subject: string; text: string }) => ({ messageId: 'fixture' })),
}));
vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: mail.sendMail, close: vi.fn() }),
}));

import { POST as register } from '../src/app/api/auth/register/route';
import { POST as login } from '../src/app/api/auth/login/route';
import { POST as requestReset } from '../src/app/api/auth/password-reset/request/route';
import { POST as confirmVerification } from '../src/app/api/auth/email-verification/confirm/route';
import { isEmailVerified, queueAccountMail } from '../src/lib/auth/account-mail';
import { resetAuthTokenMemory } from '../src/lib/auth/auth-email-token-store';
import {
  MAIL_LINK_MAX_PER_SUBJECT,
  VERIFY_MAIL_MAX_PER_ADDRESS_AND_IP,
  VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';
import { MAIL_DAILY_VERIFY_CAP, reserveMailSend, resetMailBudgetMemory } from '../src/lib/auth/mail-budget';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import {
  GOOD_PASSWORD,
  answersAtTheOpaqueFloor,
  freshClientIp,
  googleAccount,
  jsonPost,
  passwordAccount,
  stubMailConfig,
  tokenOfMail,
} from './helpers/auth-mail-fixtures';

/**
 * Password sign-up in one step: the account is made unverified and a link is mailed; the page the link opens confirms the address
 * with a button. docs/policy-decisions.md, entry 288.
 */

const REGISTER_URL = '/api/auth/register';

function signUp(email: string, extra: Record<string, unknown> = {}, options: { ip?: string } = {}) {
  return register(
    jsonPost(REGISTER_URL, { email, password: GOOD_PASSWORD, name: 'New Person', acceptedTermsVersion: TERMS_VERSION, ...extra }, options)
  );
}

const sentTo = () => mail.sendMail.mock.calls.map((call) => call[0].to).sort();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  redisUserStore.resetStore();
  redisKeyStore.resetStore();
  resetAuthTokenMemory();
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

describe('what a sign-up answers', () => {
  it('answers a new address and every kind of existing address alike, at the same time, with no session', async () => {
    await passwordAccount('verified', { emailVerified: true });
    await passwordAccount('unverified');
    await googleAccount('googler');
    const responses = await answersAtTheOpaqueFloor(
      ['brand.new', 'verified', 'unverified', 'googler'].map((label) => () => signUp(`${label}@fixture.test`))
    );
    expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(Array(4).fill({ success: true }));
    for (const response of responses) expect(response.headers.get('set-cookie')).toBeNull();
    // Only the new address was mailed, and only it has a new account.
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    await settle();
    expect(sentTo()).toEqual(['brand.new@fixture.test']);
    expect(await redisUserStore.findByEmail('brand.new@fixture.test')).toMatchObject({ provider: 'email', emailVerified: false, name: 'New Person' });
  });

  it('leaves an account that has the address as it was: its password, its flag, and no mail', async () => {
    const existing = await passwordAccount('known');
    await signUp('known@fixture.test', { password: 'Someone elses password 1!', name: 'Squatter' });
    await settle();
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(await redisUserStore.findById(existing.id)).toMatchObject({ name: 'known' });
    expect(isEmailVerified((await redisUserStore.findById(existing.id))!)).toBe(false);
    expect((await login(jsonPost('/api/auth/login', { email: existing.email, password: GOOD_PASSWORD }))).status).toBe(200);
    expect((await login(jsonPost('/api/auth/login', { email: existing.email, password: 'Someone elses password 1!' }))).status).toBe(401);
  });

  it('lets the new account sign in at once, unverified, and the link confirms it only through the POST of the page', async () => {
    await signUp('new.person@fixture.test');
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    const token = tokenOfMail(mail.sendMail.mock.calls[0][0].text);
    const signedIn = await login(jsonPost('/api/auth/login', { email: 'new.person@fixture.test', password: GOOD_PASSWORD }));
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).user.emailVerified).toBe(false);

    // The link carries the token in the fragment, which no server sees, so opening it confirms nothing; the button POSTs it.
    expect(mail.sendMail.mock.calls[0][0].text).toMatch(/\/auth\/verify-email#token=/);
    expect((await confirmVerification(jsonPost('/api/auth/email-verification/confirm', { token }))).status).toBe(200);
    expect((await redisUserStore.findByEmail('new.person@fixture.test'))?.emailVerified).toBe(true);
    expect((await confirmVerification(jsonPost('/api/auth/email-verification/confirm', { token }))).status).toBe(400);
  });

  it('refuses an address on a disposable domain, with its own code, and makes nothing and sends nothing', async () => {
    for (const email of ['someone@0-mail.com', 'Someone@Inbox.0-Mail.com']) {
      const response = await signUp(email);
      expect(response.status, email).toBe(400);
      expect((await response.json()).code, email).toBe('disposable_email');
      expect(await redisUserStore.findByEmail(email)).toBeNull();
    }
    await settle();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});

describe('the limits on the mails of a sign-up', () => {
  it(`stops the ${VERIFY_MAIL_MAX_PER_ADDRESS_AND_IP + 1}th sign-up for one address from one client within a minute with 429 and Retry-After, whether or not the address has an account`, async () => {
    for (const email of ['fresh@fixture.test', 'known@fixture.test']) {
      if (email.startsWith('known')) await passwordAccount('known', { emailVerified: true });
      const ip = freshClientIp();
      const accepted = await Promise.all(Array.from({ length: VERIFY_MAIL_MAX_PER_ADDRESS_AND_IP }, () => signUp(email, {}, { ip })));
      expect(accepted.map((response) => response.status)).toEqual([202, 202]);
      const refused = await signUp(email, {}, { ip });
      expect(refused.status, email).toBe(429);
      expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      expect((await refused.json()).code, email).toBe('mail_rate_limited');
    }
  });

  it(`stops the ${MAIL_LINK_MAX_PER_SUBJECT + 1}th sign-up for one address in ten minutes whichever clients ask`, async () => {
    const accepted = await Promise.all(Array.from({ length: MAIL_LINK_MAX_PER_SUBJECT }, () => signUp('a@fixture.test')));
    expect(accepted.map((response) => response.status)).toEqual([202, 202, 202]);
    const refused = await signUp('a@fixture.test');
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe('mail_rate_limited');
  });

  it(`sends at most ${VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY} verification mails to one address in a day, by whatever route they are asked for`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const record = await passwordAccount('flooded');
    for (let asked = 0; asked < VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY + 3; asked++) await queueAccountMail('verify', record, 'en');
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY));
    await settle();
    expect(mail.sendMail).toHaveBeenCalledTimes(VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY);
    expect(console.warn).toHaveBeenCalledWith('auth_mail_failure category=address_cap');

    // The day ends: the same address can be mailed again. A reset mail never counted.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 24 * 3_600_000 + 1_000);
    await queueAccountMail('verify', record, 'en');
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY + 1));
  });
});

describe('the mail budget of the day', () => {
  it('does not count a mail it has no room for against the daily cap of its address', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const record = await passwordAccount('queued');
    for (let sent = 0; sent < MAIL_DAILY_VERIFY_CAP; sent++) await reserveMailSend('verify');
    for (let asked = 0; asked < VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY + 2; asked++) await queueAccountMail('verify', record, 'en');
    expect(warn.mock.calls.filter(([line]) => line === 'auth_mail_failure category=budget')).toHaveLength(VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY + 2);
    expect(warn.mock.calls.some(([line]) => line === 'auth_mail_failure category=address_cap')).toBe(false);
    await settle();
    expect(mail.sendMail).not.toHaveBeenCalled();

    // The day has room again (a new day, here the counter forgotten): the address still has all of its mails for the day.
    resetMailBudgetMemory();
    for (let asked = 0; asked < VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY; asked++) await queueAccountMail('verify', record, 'en');
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(VERIFY_MAIL_MAX_PER_ADDRESS_PER_DAY));
  });

  it('refuses a sign-up with a temporary-unavailable answer, makes no account, and says the same for a known address', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await passwordAccount('known', { emailVerified: true });
    for (let sent = 0; sent < MAIL_DAILY_VERIFY_CAP; sent++) await reserveMailSend('verify');
    for (const email of ['unknown@fixture.test', 'known@fixture.test']) {
      const response = await signUp(email);
      expect(response.status, email).toBe(503);
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect((await response.json()).code, email).toBe('mail_temporarily_unavailable');
    }
    expect(await redisUserStore.findByEmail('unknown@fixture.test')).toBeNull();
    await settle();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('still sends a password reset mail when the verification mails have used their share, so a flood of sign-ups cannot block resets', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const record = await passwordAccount('owner', { emailVerified: true });
    for (let sent = 0; sent < MAIL_DAILY_VERIFY_CAP; sent++) await reserveMailSend('verify');
    await queueAccountMail('verify', record, 'en');
    await settle();
    expect(mail.sendMail).not.toHaveBeenCalled();

    const response = await requestReset(jsonPost('/api/auth/password-reset/request', { email: record.email }));
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    expect(mail.sendMail.mock.calls[0][0].subject).toContain('password');
  });
});
