import { cookies } from 'next/headers';
import { redirect } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { getSessionFromToken } from './session';
import { sessionTokenFromCookieStore } from './session-cookie';
import type { User } from './types';

/**
 * The person the dashboard renders for, read on the server from the session cookie, so the page's first paint carries their
 * data and never shows the loading state. A visitor without a cookie, or with a cookie that stands for no session (expired,
 * revoked, signed out elsewhere), is sent to the login page before the page renders. When the session store cannot answer
 * the page renders without the person (null), and the browser reads the session itself as it did before.
 */
export async function readDashboardSession(locale: AppLocale): Promise<User | null> {
  const token = sessionTokenFromCookieStore(await cookies());
  if (!token) return redirect({ href: '/auth', locale });
  let user: User | null;
  try {
    user = await getSessionFromToken(token);
  } catch (error) {
    console.error('[dashboard] Reading the session on the server failed', error);
    return null;
  }
  if (!user) return redirect({ href: '/auth', locale });
  return user;
}
