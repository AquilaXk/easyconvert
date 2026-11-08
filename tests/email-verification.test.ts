import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { from: string; to: string; subject: string; text: string }) => ({ messageId: 'fixture' })),
}));
vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: mail.sendMail, close: vi.fn() }),
}));

import { GET as verificationStatus } from '../src/app/api/auth/email-verification/route';
import { POST as resendVerification } from '../src/app/api/auth/email-verification/resend/route';
import { POST as confirmVerification } from '../src/app/api/auth/email-verification/confirm/route';
import { POST as register } from '../src/app/api/auth/register/route';
import { POST as login } from '../src/app/api/auth/login/route';
import { POST as requestReset } from '../src/app/api/auth/password-reset/request/route';
import { issueAuthToken, resetAuthTokenMemory } from '../src/lib/auth/auth-email-token-store';
import { isEmailVerified } from '../src/lib/auth/account-mail';
import { MAIL_LINK_MAX_PER_SUBJECT, resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
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
  tokenOfMail,
} from './helpers/auth-mail-fixtures';

const CONFIRM_URL = '/api/auth/email-verification/confirm';
const RESEND_URL = '/api/auth/email-verification/resend';

async function signedIn(record: Awaited<ReturnType<typeof passwordAccount>>) {
  return `${SESSION_COOKIE_NAME}=${createSessionToken(redisUserStore.sanitizeUser(record))}`;
}

function statusRequest(cookie?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/email-verification', { headers: cookie ? { cookie } : {} });
}

function registration(email: string, extra: Record<string, unknown> = {}) {
  return jsonPost('/api/auth/register', { email, password: GOOD_PASSWORD, name: 'New Person', acceptedTermsVersion: TERMS_VERSION, ...extra });
}

beforeEach(() => {
  redisUserStore.resetStore();
  resetAuthTokenMemory();
  resetLoginRateLimiterStore();
  mail.sendMail.mockClear();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('what counts as verified', () => {
  it('counts a Google account, and an email account only once its link was used', async () => {
    expect(isEmailVerified(await googleAccount('g'))).toBe(true);
    expect(isEmailVerified(await passwordAccount('p'))).toBe(false);
    expect(isEmailVerified(await passwordAccount('q', { emailVerified: true }))).toBe(true);
    // An account made before the flag existed has none.
    expect(isEmailVerified({ provider: 'email' })).toBe(false);
  });
});

describe('registration', () => {
  it('refuses an address that would name other or several recipients, and sends nothing', async () => {
    for (const email of ['a@y.com,victim@x.com', 'a@y.com;victim@x.com', '"x" <victim@x.com>@y.com', 'a@y.com\r\nBcc: victim@x.com', 'a b@y.com', 'a@localhost', `${'a'.repeat(250)}@y.com`]) {
      const response = await register(registration(email));
      expect(response.status, email).toBe(400);
      expect((await response.json()).code, email).toBe('invalid_email');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('mails a link to the new address, and leaves the account unverified until it is used', async () => {
    const response = await register(registration('new.person@fixture.test', { locale: 'ko' }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.to).toBe('new.person@fixture.test');
    expect(sent.text).toContain('https://convert.fixture.test/ko/auth/verify-email#token=');
    expect(isEmailVerified((await redisUserStore.findByEmail('new.person@fixture.test'))!)).toBe(false);

    const confirmed = await confirmVerification(jsonPost(CONFIRM_URL, { token: tokenOfMail(sent.text) }));
    expect(confirmed.status).toBe(200);
    expect(isEmailVerified((await redisUserStore.findByEmail('new.person@fixture.test'))!)).toBe(true);
  });

  it('does not wait for the mail, and does not fail when it cannot be sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mail.sendMail.mockReturnValueOnce(new Promise(() => undefined));
    // The mail never finishes; the sign-up answers all the same.
    const response = await register(registration('slow.mail@fixture.test'));
    expect(response.status).toBe(200);

    mail.sendMail.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EAUTH' }));
    expect((await register(registration('failing.mail@fixture.test'))).status).toBe(200);
  });

  it('sends nothing and behaves as before when SMTP is not configured', async () => {
    stubNoMailConfig();
    const response = await register(registration('plain@fixture.test'));
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(mail.sendMail).not.toHaveBeenCalled();
    const status = await verificationStatus(statusRequest(await signedIn((await redisUserStore.findByEmail('plain@fixture.test'))!)));
    expect(await status.json()).toEqual({ success: true, enabled: false, verified: false });
  });
});

describe('an unverified account', () => {
  it('signs in as before, including an account made before verification existed', async () => {
    await passwordAccount('old.timer');
    const response = await login(jsonPost('/api/auth/login', { email: 'old.timer@fixture.test', password: GOOD_PASSWORD }));
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
  });

  it('is not sent a password reset mail, and the answer does not show it', async () => {
    await passwordAccount('unverified');
    await passwordAccount('verified', { emailVerified: true });
    const answers = await Promise.all(
      ['unverified', 'verified'].map(async (label) => {
        const response = await requestReset(jsonPost('/api/auth/password-reset/request', { email: `${label}@fixture.test` }));
        return { status: response.status, body: await response.json() };
      })
    );
    expect(answers[0]).toEqual(answers[1]);
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    expect(mail.sendMail.mock.calls[0][0].to).toBe('verified@fixture.test');
  });

  it('is told so by the status route, which a Google account and a verified account are not', async () => {
    const unverified = await passwordAccount('unverified');
    const verified = await passwordAccount('verified', { emailVerified: true });
    const google = await googleAccount('googler');
    expect(await (await verificationStatus(statusRequest(await signedIn(unverified)))).json()).toEqual({ success: true, enabled: true, verified: false });
    expect((await (await verificationStatus(statusRequest(await signedIn(verified)))).json()).verified).toBe(true);
    expect((await (await verificationStatus(statusRequest(await signedIn(google)))).json()).verified).toBe(true);
    expect((await verificationStatus(statusRequest())).status).toBe(401);
  });
});

describe('the resend route', () => {
  it('mails a new link to a signed-in unverified account, and the old link stops working', async () => {
    const record = await passwordAccount('unverified');
    const older = await issueAuthToken('verify', { userId: record.id, email: record.email });
    const response = await resendVerification(jsonPost(RESEND_URL, { locale: 'en' }, { cookie: await signedIn(record) }));
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    const newer = tokenOfMail(mail.sendMail.mock.calls[0][0].text);
    expect(newer).not.toBe(older);
    expect((await confirmVerification(jsonPost(CONFIRM_URL, { token: older }))).status).toBe(400);
    expect((await confirmVerification(jsonPost(CONFIRM_URL, { token: newer }))).status).toBe(200);
  });

  it('answers a verified account and a Google account as it answers an unverified one, with no mail', async () => {
    const records = [await passwordAccount('unverified'), await passwordAccount('verified', { emailVerified: true }), await googleAccount('googler')];
    const cookies = await Promise.all(records.map((record) => signedIn(record)));
    const responses = await answersAtTheOpaqueFloor(cookies.map((cookie) => () => resendVerification(jsonPost(RESEND_URL, {}, { cookie }))));
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ success: true });
    }
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    expect(mail.sendMail.mock.calls[0][0].to).toBe('unverified@fixture.test');
  });

  it('needs a session', async () => {
    expect((await resendVerification(jsonPost(RESEND_URL, {}))).status).toBe(401);
  });

  it(`allows ${MAIL_LINK_MAX_PER_SUBJECT} mails per account in a window and then answers 429 with Retry-After`, async () => {
    const record = await passwordAccount('unverified');
    const cookie = await signedIn(record);
    const answers = await Promise.all(
      Array.from({ length: MAIL_LINK_MAX_PER_SUBJECT + 1 }, () => resendVerification(jsonPost(RESEND_URL, {}, { cookie })))
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 202, 202, 429]);
    const refused = answers.find((answer) => answer.status === 429)!;
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect((await refused.json()).code).toBe('mail_rate_limited');
  });

  it('answers 404 when SMTP is not configured', async () => {
    const record = await passwordAccount('unverified');
    stubNoMailConfig();
    const response = await resendVerification(jsonPost(RESEND_URL, {}, { cookie: await signedIn(record) }));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('mail_unavailable');
    expect((await confirmVerification(jsonPost(CONFIRM_URL, { token: 'A'.repeat(43) }))).status).toBe(404);
  });
});

describe('the confirm route', () => {
  it('uses a token up, and keeps it valid for 24 hours but not longer', async () => {
    const record = await passwordAccount('unverified');
    const token = await issueAuthToken('verify', { userId: record.id, email: record.email });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 23 * 3_600_000);
    expect((await confirmVerification(jsonPost(CONFIRM_URL, { token }))).status).toBe(200);
    expect((await confirmVerification(jsonPost(CONFIRM_URL, { token }))).status).toBe(400);

    const other = await passwordAccount('late');
    const late = await issueAuthToken('verify', { userId: other.id, email: other.email });
    vi.setSystemTime(Date.now() + 24 * 3_600_000 + 1_000);
    const refused = await confirmVerification(jsonPost(CONFIRM_URL, { token: late }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe('invalid_token');
    expect(isEmailVerified((await redisUserStore.findById(other.id))!)).toBe(false);
    vi.useRealTimers();
  });

  it('does not take a reset token, and needs no session', async () => {
    const record = await passwordAccount('unverified');
    const reset = await issueAuthToken('reset', { userId: record.id, email: record.email });
    expect((await confirmVerification(jsonPost(CONFIRM_URL, { token: reset }))).status).toBe(400);
    const token = await issueAuthToken('verify', { userId: record.id, email: record.email });
    expect((await confirmVerification(jsonPost(CONFIRM_URL, { token }, { ip: freshClientIp() }))).status).toBe(200);
  });
});
