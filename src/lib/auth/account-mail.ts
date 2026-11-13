import type { AppLocale } from '@/i18n/routing';
import { dispatchAuthMail } from './auth-mail';
import { renderAuthMail, type AuthMailKind } from './auth-mail-templates';
import { issueAuthToken } from './auth-email-token-store';
import { consumeVerifyMailDailyCap } from './login-rate-limiter';
import { mailLink } from './mail-config';
import { isPlainMailbox } from './mailbox';
import { isEmailVerified, isPasswordAccount } from './email-verified';
import type { UserRecord } from './types';

/** The page a mail of each kind links to (the token follows in the URL fragment, which no server or referrer sees). */
const MAIL_PAGE: Record<AuthMailKind, string> = {
  reset: '/auth/reset-password',
  verify: '/auth/verify-email',
};

const TOKEN_PURPOSE = { reset: 'reset', verify: 'verify' } as const;

export { isEmailVerified, isPasswordAccount };

/**
 * Makes a token for the account and sends its mail without waiting for the server of the mailbox. A failure of the token
 * store throws; a failure of the send is logged by its category and does not. A verification mail past the daily cap of its
 * address is not made (logged as `address_cap`): the routes that ask for it answer alike whether it was sent or not.
 */
export async function queueAccountMail(kind: AuthMailKind, record: UserRecord, locale: AppLocale): Promise<void> {
  // An address stored before registration checked its form gets no token and no mail.
  if (!isPlainMailbox(record.email)) return;
  if (kind === 'verify' && !(await consumeVerifyMailDailyCap(record.email)).allowed) {
    console.warn('auth_mail_failure category=address_cap');
    return;
  }
  const token = await issueAuthToken(TOKEN_PURPOSE[kind], { userId: record.id, email: record.email });
  dispatchAuthMail(record.email, renderAuthMail(kind, locale, mailLink(locale, MAIL_PAGE[kind], token)), kind);
}
