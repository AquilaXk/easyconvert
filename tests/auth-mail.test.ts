import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  sendMail: vi.fn(),
  close: vi.fn(),
}));
vi.mock('nodemailer', () => ({
  createTransport: (options: Record<string, unknown>) => {
    transport.options.push(options);
    return { sendMail: transport.sendMail, close: transport.close };
  },
}));

import {
  MAIL_CONNECTION_TIMEOUT_MS,
  MAIL_DNS_TIMEOUT_MS,
  MAIL_FAILURE_CATEGORIES,
  MAIL_GREETING_TIMEOUT_MS,
  MAIL_MAX_IN_FLIGHT,
  MAIL_REQUEST_DEADLINE_MS,
  MAIL_SOCKET_TIMEOUT_MS,
  MailFailure,
  classifyMailError,
  dispatchAuthMail,
  sendAuthMail,
} from '../src/lib/auth/auth-mail';
import { FAKE_SMTP, stubMailConfig, stubNoMailConfig } from './helpers/auth-mail-fixtures';

const MAIL = { subject: 'subject', text: 'body' };
const RECIPIENT = 'private.recipient@fixture.test';

/** Every string a log line or an error must never carry. */
const SECRETS = [FAKE_SMTP.SMTP_HOST, FAKE_SMTP.SMTP_USER, FAKE_SMTP.SMTP_PASSWORD, RECIPIENT, 'provider said: 535 5.7.8 Username and Password not accepted'];

function leakyError(code: string, cause?: unknown) {
  return Object.assign(new Error(`${SECRETS.join(' | ')}`), { code, command: 'AUTH PLAIN', response: SECRETS.join(' '), ...(cause ? { cause } : {}) });
}

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  transport.options.length = 0;
  transport.sendMail.mockReset();
  transport.close.mockReset();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the transport', () => {
  it('requires STARTTLS on 587 and a checked certificate, with timeouts that fit inside the request deadline', async () => {
    transport.sendMail.mockResolvedValue({});
    await sendAuthMail(RECIPIENT, MAIL);
    expect(transport.options[0]).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(transport.options[0]).toMatchObject({
      connectionTimeout: MAIL_CONNECTION_TIMEOUT_MS,
      greetingTimeout: MAIL_GREETING_TIMEOUT_MS,
      socketTimeout: MAIL_SOCKET_TIMEOUT_MS,
      dnsTimeout: MAIL_DNS_TIMEOUT_MS,
    });
    for (const timeout of [MAIL_CONNECTION_TIMEOUT_MS, MAIL_GREETING_TIMEOUT_MS, MAIL_SOCKET_TIMEOUT_MS, MAIL_DNS_TIMEOUT_MS]) {
      expect(timeout).toBeLessThan(MAIL_REQUEST_DEADLINE_MS);
    }
    expect(transport.close).toHaveBeenCalled();
  });

  it('connects over TLS from the first byte on port 465 and takes the sender from MAIL_FROM', async () => {
    transport.sendMail.mockResolvedValue({});
    vi.stubEnv('SMTP_PORT', '465');
    vi.stubEnv('MAIL_FROM', 'EasyConvert <noreply@fixture.test>');
    await sendAuthMail(RECIPIENT, MAIL);
    expect(transport.options[0]).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(transport.sendMail.mock.calls[0][0]).toMatchObject({ from: 'EasyConvert <noreply@fixture.test>', to: RECIPIENT, text: 'body' });
    expect(Object.keys(transport.sendMail.mock.calls[0][0]).sort()).toEqual(['from', 'subject', 'text', 'to']);
  });

  it('refuses to send, as a configuration failure, when mail is not configured', async () => {
    stubNoMailConfig();
    await expect(sendAuthMail(RECIPIENT, MAIL)).rejects.toMatchObject({ category: 'configuration' });
    expect(transport.options).toHaveLength(0);
  });
});

describe('the request deadline', () => {
  it('abandons a send that outlives it, as a timeout, and closes the connection', async () => {
    vi.useFakeTimers();
    transport.sendMail.mockReturnValue(new Promise(() => undefined));
    const outcome = sendAuthMail(RECIPIENT, MAIL).then(
      () => 'sent',
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(MAIL_REQUEST_DEADLINE_MS - 1);
    expect(transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(await outcome).toMatchObject({ category: 'timeout' });
    expect(transport.close).toHaveBeenCalled();
  });
});

describe('the failure category', () => {
  it.each([
    ['EAUTH', 'authentication'],
    ['ETIMEDOUT', 'timeout'],
    ['ETLS', 'tls'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['EDNS', 'dns'],
    ['ENOTFOUND', 'dns'],
    ['ECONNECTION', 'connection'],
    ['ECONNREFUSED', 'connection'],
    ['EENVELOPE', 'transport'],
    ['SOMETHING_NEW', 'transport'],
  ])('%s is %s', (code, category) => {
    expect(classifyMailError(leakyError(code))).toBe(category);
  });

  it('reads the code of a cause when the error has none of its own, and never the text', () => {
    expect(classifyMailError(leakyError('ESOCKET', leakyError('ENOTFOUND')))).toBe('dns');
    expect(classifyMailError(new Error('EAUTH 535 timeout dns tls'))).toBe('transport');
    expect(classifyMailError('EAUTH')).toBe('transport');
    expect(classifyMailError(undefined)).toBe('transport');
  });

  it('only ever names a category from the list', () => {
    for (const category of MAIL_FAILURE_CATEGORIES) expect(new MailFailure(category).message).toBe(`mail_failure category=${category}`);
  });
});

describe('a failed send in the background', () => {
  it.each([
    ['EAUTH', 'authentication'],
    ['ETIMEDOUT', 'timeout'],
    ['ECONNECTION', 'connection'],
  ])('logs one line with the category %s and no provider text, host, account, password or recipient', async (code, category) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    transport.sendMail.mockRejectedValue(leakyError(code));

    dispatchAuthMail(RECIPIENT, MAIL);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(warn.mock.calls).toEqual([[`auth_mail_failure category=${category}`]]);
    for (const spy of [warn, error, log]) {
      for (const secret of SECRETS) expect(logged(spy)).not.toContain(secret);
    }
    expect(error).not.toHaveBeenCalled();
  });

  it('logs the same for an error that is not a mail error at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    transport.sendMail.mockRejectedValue(new Error(SECRETS.join(' ')));
    dispatchAuthMail(RECIPIENT, MAIL);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls).toEqual([['auth_mail_failure category=transport']]);
  });

  it(`drops a send beyond ${MAIL_MAX_IN_FLIGHT} at once as busy, and takes sends again when some end`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const releases: Array<() => void> = [];
    transport.sendMail.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
    for (let index = 0; index < MAIL_MAX_IN_FLIGHT + 2; index++) dispatchAuthMail(RECIPIENT, MAIL);
    await vi.waitFor(() => expect(releases).toHaveLength(MAIL_MAX_IN_FLIGHT));
    expect(warn.mock.calls).toEqual([['auth_mail_failure category=busy'], ['auth_mail_failure category=busy']]);

    releases.forEach((release) => release());
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(MAIL_MAX_IN_FLIGHT));
    transport.sendMail.mockResolvedValue({});
    dispatchAuthMail(RECIPIENT, MAIL);
    await vi.waitFor(() => expect(transport.sendMail).toHaveBeenCalledTimes(MAIL_MAX_IN_FLIGHT + 1));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
