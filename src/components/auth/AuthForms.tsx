'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, User } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { LEGAL_DOCUMENTS } from '@/lib/legal/documents';

export type AuthTab = 'login' | 'register';

/** The `error` codes the OAuth callback redirects with; each is worded as `auth.oauthErrors.<code>`. */
const OAUTH_ERROR_CODES = [
  'oauth_code_missing',
  'oauth_denied',
  'invalid_oauth_callback',
  'invalid_oauth_state',
  'oauth_exchange_failed',
  'account_linking_required',
  'terms_required',
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
      className="w-full min-h-[44px] flex items-center justify-center gap-3 px-4 py-2.5 rounded-sm border border-rule bg-surface hover:bg-sunken text-ink font-medium text-sm transition-colors disabled:opacity-60"
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
  const inputBaseClass =
    'w-full min-h-[44px] pl-10 pr-4 py-2.5 rounded-sm border border-rule-strong bg-surface/80 text-ink text-base transition-colors';

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {activeTab === 'register' && (
        <div>
          <label
            htmlFor="auth-full-name"
            className="block text-xs font-semibold text-ink mb-1.5"
          >
            {t('name')}
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-3">
              <User className="w-4 h-4" />
            </div>
            <input
              id="auth-full-name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder={t('namePlaceholder')}
              className={inputBaseClass}
            />
          </div>
        </div>
      )}

      <div>
        <label
          htmlFor="auth-email"
          className="block text-xs font-semibold text-ink mb-1.5"
        >
          {t('email')}
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-3">
            <Mail className="w-4 h-4" />
          </div>
          <input
            id="auth-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder={t('emailPlaceholder')}
            className={inputBaseClass}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="auth-password"
          className="block text-xs font-semibold text-ink mb-1.5"
        >
          {t('password')}
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-3">
            <Lock className="w-4 h-4" />
          </div>
          <input
            id="auth-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete={activeTab === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="••••••••"
            className="w-full min-h-[44px] pl-10 pr-12 py-2.5 rounded-sm border border-rule-strong bg-surface/80 text-ink text-base transition-colors"
          />
          <button
            type="button"
            onClick={onTogglePassword}
            aria-label={showPassword ? t('hidePassword') : t('showPassword')}
            className="min-w-[44px] min-h-[44px] absolute inset-y-0 right-0 flex items-center justify-center rounded-sm text-ink-3 hover:text-ink transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {activeTab === 'register' && (
        <div>
          <label
            htmlFor="auth-confirm-password"
            className="block text-xs font-semibold text-ink mb-1.5"
          >
            {t('confirmPassword')}
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-3">
              <Lock className="w-4 h-4" />
            </div>
            <input
              id="auth-confirm-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => onConfirmPasswordChange(e.target.value)}
              placeholder="••••••••"
              className={inputBaseClass}
            />
          </div>
        </div>
      )}

      {activeTab === 'register' && (
        <div className="flex items-center gap-3 min-h-[44px]">
          <input
            id="auth-accept-terms"
            type="checkbox"
            required
            checked={acceptedTerms}
            onChange={(e) => onAcceptedTermsChange(e.target.checked)}
            className="size-4 cursor-pointer"
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
        className="btn-primary w-full min-h-[48px] mt-2 flex items-center justify-center gap-2 py-3 px-4 rounded-sm font-semibold text-base disabled:opacity-60"
      >
        {isSubmitting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            <span>{activeTab === 'login' ? t('signIn') : t('createAccount')}</span>
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
    </form>
  );
}
