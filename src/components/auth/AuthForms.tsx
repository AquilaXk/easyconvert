'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { LEGAL_DOCUMENTS } from '@/lib/legal/documents';

export type AuthTab = 'login' | 'register';

/** The 32 px height of the form controls; 44 px where the pointer is a finger, as the accessibility statement promises. */
export const CONTROL_HEIGHT = 'h-8 [@media(pointer:coarse)]:h-11';

/** The `error` codes the OAuth callback redirects with; each is worded as `auth.oauthErrors.<code>`. */
const OAUTH_ERROR_CODES = [
  'oauth_code_missing',
  'oauth_denied',
  'invalid_oauth_callback',
  'invalid_oauth_state',
  'oauth_exchange_failed',
  'account_linking_required',
  'terms_required',
  'terms_outdated',
] as const;

export type OAuthErrorKey = (typeof OAUTH_ERROR_CODES)[number] | 'generic';

/** The message key for the callback's `error` parameter: a known code, else the generic failure. */
export function resolveOAuthErrorKey(urlError: string | null): OAuthErrorKey | null {
  if (!urlError) return null;
  return (OAUTH_ERROR_CODES as readonly string[]).includes(urlError) ? (urlError as OAuthErrorKey) : 'generic';
}

export type RegistrationProblem = 'passwordTooShort' | 'passwordMismatch';

export function validateRegistrationInput(password: string, confirmPassword: string): RegistrationProblem | null {
  if (password.length < 8) return 'passwordTooShort';
  if (password !== confirmPassword) return 'passwordMismatch';
  return null;
}

/**
 * The link to the password reset page. It asks the server whether reset is on (mail is configured) and shows nothing until
 * the answer says so, so a server without mail never offers a page that cannot work.
 */
function ForgotPasswordLink() {
  const t = useTranslations('auth.form');
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/password-reset')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { enabled?: unknown } | null) => {
        if (!cancelled) setEnabled(data?.enabled === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!enabled) return null;
  return (
    <div className="mt-2 text-right">
      <Link href="/auth/forgot-password" className="text-sm font-medium text-accent-ink hover:underline rounded-xs">
        {t('forgotPassword')}
      </Link>
    </div>
  );
}

export function GoogleOAuthButton({
  isGoogleLoading,
  disabled,
  onClick,
}: Readonly<{
  isGoogleLoading: boolean;
  disabled: boolean;
  onClick: () => void;
}>) {
  const t = useTranslations('auth.form');
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${CONTROL_HEIGHT} w-full flex items-center justify-center gap-2 px-2.5 rounded-xs border border-rule bg-surface hover:bg-sunken text-ink font-medium text-sm transition-colors disabled:opacity-60`}
    >
      {isGoogleLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-accent-ink" />
      ) : (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
        </svg>
      )}
      <span>{t('google')}</span>
    </button>
  );
}

export interface AuthCredentialsFormProps {
  activeTab: AuthTab;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  acceptedTerms: boolean;
  showPassword: boolean;
  isBusy: boolean;
  isSubmitting: boolean;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onAcceptedTermsChange: (value: boolean) => void;
  onTogglePassword: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function AuthCredentialsForm({
  activeTab,
  name,
  email,
  password,
  confirmPassword,
  acceptedTerms,
  showPassword,
  isBusy,
  isSubmitting,
  onNameChange,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onAcceptedTermsChange,
  onTogglePassword,
  onSubmit,
}: Readonly<AuthCredentialsFormProps>) {
  const t = useTranslations('auth.form');
  const inputClass =
    `${CONTROL_HEIGHT} w-full px-2.5 rounded-xs border border-rule bg-sunken text-ink text-base transition-colors`;
  const labelClass = 'block text-sm font-medium text-ink-2 mb-1';

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {activeTab === 'register' && (
        <div>
          <label htmlFor="auth-full-name" className={labelClass}>
            {t('name')}
          </label>
          <input
            id="auth-full-name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('namePlaceholder')}
            className={inputClass}
          />
        </div>
      )}

      <div>
        <label htmlFor="auth-email" className={labelClass}>
          {t('email')}
        </label>
        <input
          id="auth-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder={t('emailPlaceholder')}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="auth-password" className={labelClass}>
          {t('password')}
        </label>
        <div className="relative">
          <input
            id="auth-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete={activeTab === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            className={`${inputClass} pr-9 [@media(pointer:coarse)]:pr-11`}
          />
          <button
            type="button"
            onClick={onTogglePassword}
            aria-label={showPassword ? t('hidePassword') : t('showPassword')}
            className="absolute inset-y-0 right-0 w-8 [@media(pointer:coarse)]:w-11 flex items-center justify-center rounded-xs text-ink-3 hover:text-ink transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {activeTab === 'login' && <ForgotPasswordLink />}
      </div>

      {activeTab === 'register' && (
        <div>
          <label htmlFor="auth-confirm-password" className={labelClass}>
            {t('confirmPassword')}
          </label>
          <input
            id="auth-confirm-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            className={inputClass}
          />
        </div>
      )}

      {activeTab === 'register' && (
        <div className="flex items-center gap-2">
          <input
            id="auth-accept-terms"
            type="checkbox"
            required
            checked={acceptedTerms}
            onChange={(e) => onAcceptedTermsChange(e.target.checked)}
            className="checkbox cursor-pointer"
          />
          <label htmlFor="auth-accept-terms" className="text-sm text-ink cursor-pointer select-none">
            {t.rich('acceptTerms', {
              link: (chunks) => (
                <Link href={LEGAL_DOCUMENTS.terms.path} target="_blank" className="font-medium text-accent-ink hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </label>
        </div>
      )}

      <button
        type="submit"
        disabled={isBusy}
        className={`${CONTROL_HEIGHT} w-full flex items-center justify-center px-2.5 rounded-xs bg-accent text-on-accent hover:bg-accent-hover text-sm font-medium transition-colors disabled:opacity-60`}
      >
        {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>{activeTab === 'login' ? t('signIn') : t('createAccount')}</span>}
      </button>
    </form>
  );
}
