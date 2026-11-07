import { createTransport } from 'nodemailer';
import { readMailConfig } from './mail-config';
import type { AuthMail } from './auth-mail-templates';

/**
 * The SMTP sender of the password reset and email verification mails (STARTTLS on port 587 by default, a full account
 * address and an application password).
 *
 * A send is bounded: the transport timeouts all fit inside one hard deadline, and a send that outlives it is abandoned. A
 * failure is logged as one allow-listed category and nothing else: the error of the provider, the host, the account, the
 * password and the recipient never reach a log line or an answer, since all of them can sit in the error's text.
 */

export const MAIL_REQUEST_DEADLINE_MS = 10_000;
export const MAIL_CONNECTION_TIMEOUT_MS = 5_000;
export const MAIL_GREETING_TIMEOUT_MS = 5_000;
export const MAIL_SOCKET_TIMEOUT_MS = 8_000;
export const MAIL_DNS_TIMEOUT_MS = 4_000;
/** Sends that may run at once; a request beyond it is dropped and logged as `busy`, so a flood cannot pile up sockets. */
export const MAIL_MAX_IN_FLIGHT = 16;

export const MAIL_FAILURE_CATEGORIES = [
  'timeout',
  'authentication',
  'tls',
  'dns',
  'connection',
  'configuration',
  'busy',
  'transport',
] as const;

export type MailFailureCategory = (typeof MAIL_FAILURE_CATEGORIES)[number];

/** A failed send. Its message is the category and nothing else. */
export class MailFailure extends Error {
  constructor(readonly category: MailFailureCategory) {
    super(`mail_failure category=${category}`);
    this.name = 'MailFailure';
  }
}

const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH)/;
const MAX_CAUSE_DEPTH = 4;

const CODE_CATEGORIES: Readonly<Record<string, MailFailureCategory>> = {
  EAUTH: 'authentication',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  ETLS: 'tls',
  EDNS: 'dns',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  ECONNECTION: 'connection',
  ECONNREFUSED: 'connection',
  ECONNRESET: 'connection',
  EHOSTUNREACH: 'connection',
  ENETUNREACH: 'connection',
};

/** The category of a send error, from its codes only; the text of the error is never read. */
export function classifyMailError(error: unknown): MailFailureCategory {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') {
      if (TLS_CODE.test(code)) return 'tls';
      const category = CODE_CATEGORIES[code];
      if (category) return category;
    }
    current = cause;
  }
  return 'transport';
}

function withinDeadline<T>(work: Promise<T>, onDeadline: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onDeadline();
      reject(new MailFailure('timeout'));
    }, MAIL_REQUEST_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Sends `mail` to `to`. Resolves when the server accepted it; rejects with a `MailFailure` of one category. */
export async function sendAuthMail(to: string, mail: AuthMail): Promise<void> {
  const config = readMailConfig();
  if (config === null) throw new MailFailure('configuration');
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: MAIL_CONNECTION_TIMEOUT_MS,
    greetingTimeout: MAIL_GREETING_TIMEOUT_MS,
    socketTimeout: MAIL_SOCKET_TIMEOUT_MS,
    dnsTimeout: MAIL_DNS_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await withinDeadline(
      transport.sendMail({ from: config.from, to, subject: mail.subject, text: mail.text }),
      () => transport.close()
    );
  } catch (error) {
    throw error instanceof MailFailure ? error : new MailFailure(classifyMailError(error));
  } finally {
    transport.close();
  }
}

let inFlight = 0;

/**
 * Sends a mail without making the caller wait for it: the caller answers on its own schedule, and a failure is logged as
 * its category. Never rejects.
 */
export function dispatchAuthMail(to: string, mail: AuthMail): void {
  if (inFlight >= MAIL_MAX_IN_FLIGHT) {
    console.warn(`auth_mail_failure category=busy`);
    return;
  }
  inFlight++;
  sendAuthMail(to, mail)
    .catch((error: unknown) => {
      const category = error instanceof MailFailure ? error.category : 'transport';
      console.warn(`auth_mail_failure category=${category}`);
    })
    .finally(() => {
      inFlight--;
    });
}
