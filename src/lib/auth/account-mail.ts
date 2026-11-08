import type { AppLocale } from '@/i18n/routing';
import { dispatchAuthMail } from './auth-mail';
import { renderAuthMail, type AuthMailKind } from './auth-mail-templates';
import { issueAuthToken } from './auth-email-token-store';
import { mailLink } from './mail-config';
import { isPlainMailbox } from './mailbox';
import type { UserRecord } from './types';

/** The page a mail of each kind links to (the token follows in the URL fragment, which no server or referrer sees). */
const MAIL_PAGE: Record<AuthMailKind, string> = {
  reset: '/auth/reset-password',
  verify: '/auth/verify-email',
};

const TOKEN_PURPOSE = { reset: 'reset', verify: 'verify' } as const;

/** Whether the address of the account is known to be the owner's: Google vouches for it, an email sign-up mails a link. */
export function isEmailVerified(record: Pick<UserRecord, 'provider' | 'emailVerified'>): boolean {
  return record.provider === 'google' || record.emailVerified === true;
}

/** An account that signs in with an email and a password and has not been linked to Google. */
export function isPasswordAccount(record: Pick<UserRecord, 'provider' | 'passwordHash' | 'salt'>): boolean {
  return record.provider === 'email' && Boolean(record.passwordHash) && Boolean(record.salt);
}

/**
 * Makes a token for the account and sends its mail without waiting for the server of the mailbox. A failure of the token
 * store throws; a failure of the send is logged by its category and does not.
 */
export async function queueAccountMail(kind: AuthMailKind, record: UserRecord, locale: AppLocale): Promise<void> {
  // An address stored before registration checked its form gets no token and no mail.
  if (!isPlainMailbox(record.email)) return;
  const token = await issueAuthToken(TOKEN_PURPOSE[kind], { userId: record.id, email: record.email });
  dispatchAuthMail(record.email, renderAuthMail(kind, locale, mailLink(locale, MAIL_PAGE[kind], token)));
}
