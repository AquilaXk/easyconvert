import { cookies } from 'next/headers';
import { redirect } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { SESSION_COOKIE_NAME } from './session';

/**
 * Sends a visitor who carries no session cookie to the login page before the page renders, so the dashboard never flashes
 * its loading state for them. The cookie is only checked for being there: a stale one still gets the page and the client
 * read of the session redirects it.
 */
export async function redirectWithoutSessionCookie(locale: AppLocale): Promise<void> {
  const jar = await cookies();
  if (!jar.has(SESSION_COOKIE_NAME)) redirect({ href: '/auth', locale });
}
