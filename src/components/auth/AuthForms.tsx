'use client';

import React from 'react';
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, User } from 'lucide-react';

export type AuthTab = 'login' | 'register';

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_code_missing: 'Authentication request cancelled or authorization code missing.',
  oauth_denied: 'Google sign-in was cancelled before completion.',
  invalid_oauth_callback: 'Invalid OAuth callback parameters. Please try signing in again.',
  invalid_oauth_state: 'Invalid authentication state. Try signing in again.',
  oauth_exchange_failed: 'Could not verify Google credentials. Please try signing in again.',
  account_linking_required:
    'An account with this email already exists. Sign in with your password first to link Google.',
};

export function resolveOAuthErrorMessage(urlError: string | null): string | null {
  if (!urlError) return null;
  if (Object.hasOwn(OAUTH_ERROR_MESSAGES, urlError)) {
    return OAUTH_ERROR_MESSAGES[urlError];
  }
  return 'Authentication failed. Please try signing in again.';
}

export function validateRegistrationInput(password: string, confirmPassword: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (password !== confirmPassword) {
    return 'Passwords do not match.';
  }
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full min-h-[44px] flex items-center justify-center gap-3 px-4 py-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-elevated hover:bg-neutral-subtle dark:hover:bg-dark-border text-brand-950 dark:text-white font-medium text-sm transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 disabled:opacity-60"
    >
      {isGoogleLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-brand-700 dark:text-brand-400" />
      ) : (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
        </svg>
      )}
      <span>Continue with Google</span>
    </button>
  );
}

export interface AuthCredentialsFormProps {
  activeTab: AuthTab;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  showPassword: boolean;
  isBusy: boolean;
  isSubmitting: boolean;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onTogglePassword: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function AuthCredentialsForm({
  activeTab,
  name,
  email,
  password,
  confirmPassword,
  showPassword,
  isBusy,
  isSubmitting,
  onNameChange,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onTogglePassword,
  onSubmit,
}: Readonly<AuthCredentialsFormProps>) {
  const inputBaseClass =
    'w-full min-h-[44px] pl-10 pr-4 py-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-neutral-scaffold/60 dark:bg-dark-elevated text-brand-950 dark:text-white text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 dark:focus-visible:ring-brand-400 transition-colors';

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {activeTab === 'register' && (
        <div>
          <label
            htmlFor="auth-full-name"
            className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1.5"
          >
            Full Name
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-muted dark:text-dark-muted">
              <User className="w-4 h-4" />
            </div>
            <input
              id="auth-full-name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Alex Morgan"
              className={inputBaseClass}
            />
          </div>
        </div>
      )}

      <div>
        <label
          htmlFor="auth-email"
          className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1.5"
        >
          Email Address
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-muted dark:text-dark-muted">
            <Mail className="w-4 h-4" />
          </div>
          <input
            id="auth-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="alex@example.com"
            className={inputBaseClass}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="auth-password"
          className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1.5"
        >
          Password
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-muted dark:text-dark-muted">
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
            className="w-full min-h-[44px] pl-10 pr-12 py-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-neutral-scaffold/60 dark:bg-dark-elevated text-brand-950 dark:text-white text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 dark:focus-visible:ring-brand-400 transition-colors"
          />
          <button
            type="button"
            onClick={onTogglePassword}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="min-w-[44px] min-h-[44px] absolute inset-y-0 right-0 flex items-center justify-center rounded-md text-ink-muted dark:text-dark-muted hover:text-brand-950 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {activeTab === 'register' && (
        <div>
          <label
            htmlFor="auth-confirm-password"
            className="block text-xs font-semibold text-brand-950 dark:text-dark-text mb-1.5"
          >
            Confirm Password
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-muted dark:text-dark-muted">
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

      <button
        type="submit"
        disabled={isBusy}
        className="w-full min-h-[48px] mt-2 flex items-center justify-center gap-2 py-3 px-4 rounded-md bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white font-semibold text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 transition-colors disabled:opacity-60"
      >
        {isSubmitting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            <span>{activeTab === 'login' ? 'Sign In' : 'Create Account'}</span>
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
    </form>
  );
}
