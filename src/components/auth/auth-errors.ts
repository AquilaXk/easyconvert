import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useServerErrorMessage } from '../i18n/problems';
import type { AuthTab } from './AuthForms';

/**
 * What an untyped refusal of `/api/auth/login` and `/api/auth/register` means, by its status: each status those routes
 * answer stands for one cause, so the interface words it in the page's language; the routes keep their English `error`.
 */
const AUTH_STATUS_MESSAGES = {
  login: { 400: 'missingFields', 401: 'invalidCredentials' },
  register: { 400: 'invalidRegistration', 409: 'accountExists' },
} as const satisfies Record<AuthTab, Record<number, string>>;

type AuthStatusMessages = (typeof AUTH_STATUS_MESSAGES)[AuthTab];

function hasProblemType(payload: unknown): boolean {
  return Boolean(payload) && typeof payload === 'object' && typeof (payload as Record<string, unknown>).type === 'string';
}

/** The sentence for a refused sign-in or sign-up: a typed problem by its type, an untyped refusal by its status. */
export function useAuthErrorMessage(): (tab: AuthTab, status: number, payload: unknown) => string {
  const t = useTranslations('auth.messages');
  const serverErrorMessage = useServerErrorMessage();
  return useCallback(
    (tab: AuthTab, status: number, payload: unknown) => {
      const byStatus: AuthStatusMessages = AUTH_STATUS_MESSAGES[tab];
      const key = hasProblemType(payload) ? undefined : byStatus[status as keyof AuthStatusMessages];
      return key ? t(key) : serverErrorMessage(payload, t('failed'));
    },
    [t, serverErrorMessage]
  );
}
