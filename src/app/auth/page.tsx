'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  User,
} from 'lucide-react';

type AuthTab = 'login' | 'register';

function resolveOAuthErrorMessage(urlError: string | null): string | null {
  if (!urlError) return null;
  if (urlError === 'oauth_code_missing') {
    return 'Authentication request cancelled or authorization code missing.';
  }
  if (urlError === 'invalid_oauth_state') {
    return 'Invalid authentication state. Try signing in again.';
  }
  return decodeURIComponent(urlError);
}

function validateRegistrationInput(password: string, confirmPassword: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (password !== confirmPassword) {
    return 'Passwords do not match.';
  }
  return null;
}

function GoogleOAuthButton({
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
      className="w-full min-h-[44px] flex items-center justify-center gap-3 px-4 py-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-elevated hover:bg-neutral-subtle dark:hover:bg-dark-border text-brand-950 dark:text-white font-medium text-sm transition-colors shadow-sm disabled:opacity-60"
    >
      {isGoogleLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-brand-700 dark:text-brand-400" />
      ) : (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
          />
        </svg>
      )}
      <span>Continue with Google</span>
    </button>
  );
}

interface AuthCredentialsFormProps {
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

function AuthCredentialsForm({
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
    'w-full min-h-[44px] pl-10 pr-4 py-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-neutral-scaffold/60 dark:bg-dark-elevated text-brand-950 dark:text-white text-base focus:outline-none focus:ring-2 focus:ring-brand-700/50 dark:focus:ring-brand-500/50 transition-colors';

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
            className="w-full min-h-[44px] pl-10 pr-12 py-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-neutral-scaffold/60 dark:bg-dark-elevated text-brand-950 dark:text-white text-base focus:outline-none focus:ring-2 focus:ring-brand-700/50 dark:focus:ring-brand-500/50 transition-colors"
          />
          <button
            type="button"
            onClick={onTogglePassword}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="min-w-[44px] min-h-[44px] absolute inset-y-0 right-0 flex items-center justify-center rounded-md text-ink-muted dark:text-dark-muted hover:text-brand-950 dark:hover:text-white transition-colors"
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
        className="w-full min-h-[48px] mt-2 flex items-center justify-center gap-2 py-3 px-4 rounded-md bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white font-semibold text-base shadow-sm transition-colors disabled:opacity-60"
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

function LoginFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialTab: AuthTab = searchParams.get('tab') === 'register' ? 'register' : 'login';
  const urlError = searchParams.get('error');

  const [activeTab, setActiveTab] = useState<AuthTab>(initialTab);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    const resolved = resolveOAuthErrorMessage(urlError);
    if (resolved) {
      setErrorMessage(resolved);
    }
  }, [urlError]);

  const handleTabSwitch = (tab: AuthTab) => {
    setActiveTab(tab);
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleGoogleLogin = async () => {
    setIsGoogleLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/auth/google/url');
      const data = await res.json();
      if (data.success && data.url) {
        window.location.href = data.url;
        return;
      }
      setErrorMessage('Failed to initiate Google authentication.');
      setIsGoogleLoading(false);
    } catch {
      setErrorMessage('Network error initiating Google authentication.');
      setIsGoogleLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!email || !password) {
      setErrorMessage('Fill in all required fields.');
      return;
    }

    if (activeTab === 'register') {
      const regError = validateRegistrationInput(password, confirmPassword);
      if (regError) {
        setErrorMessage(regError);
        return;
      }
    }

    setIsLoading(true);

    try {
      const endpoint = activeTab === 'register' ? '/api/auth/register' : '/api/auth/login';
      const payload = activeTab === 'register' ? { email, password, name } : { email, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'Authentication failed. Check your credentials and try again.');
        setIsLoading(false);
        return;
      }

      setSuccessMessage(
        activeTab === 'register' ? 'Account created. Redirecting...' : 'Signed in. Redirecting...'
      );
      setTimeout(() => {
        router.push('/dashboard');
        router.refresh();
      }, 500);
    } catch {
      setErrorMessage('Connection error while signing in. Try again.');
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-md w-full bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl shadow-sm p-6 sm:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-brand-950 dark:text-white">
          {activeTab === 'login' ? 'Sign in to EasyConvert' : 'Create an EasyConvert account'}
        </h1>
        <p className="mt-1.5 text-sm text-ink-secondary dark:text-dark-muted">
          Manage developer API keys, webhooks, and conversion history.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Authentication mode"
        className="flex rounded-lg bg-neutral-subtle dark:bg-dark-elevated p-1 mb-6 border border-neutral-border dark:border-dark-border"
      >
        <button
          id="auth-tab-login"
          role="tab"
          aria-selected={activeTab === 'login'}
          aria-controls="auth-tabpanel"
          type="button"
          onClick={() => handleTabSwitch('login')}
          className={`flex-1 min-h-[44px] px-3 py-2 text-sm font-semibold rounded-md transition-colors ${
            activeTab === 'login'
              ? 'bg-white dark:bg-dark-surface text-brand-700 dark:text-white shadow-sm'
              : 'text-ink-secondary dark:text-dark-muted hover:text-brand-950 dark:hover:text-white'
          }`}
        >
          Sign In
        </button>
        <button
          id="auth-tab-register"
          role="tab"
          aria-selected={activeTab === 'register'}
          aria-controls="auth-tabpanel"
          type="button"
          onClick={() => handleTabSwitch('register')}
          className={`flex-1 min-h-[44px] px-3 py-2 text-sm font-semibold rounded-md transition-colors ${
            activeTab === 'register'
              ? 'bg-white dark:bg-dark-surface text-brand-700 dark:text-white shadow-sm'
              : 'text-ink-secondary dark:text-dark-muted hover:text-brand-950 dark:hover:text-white'
          }`}
        >
          Sign Up
        </button>
      </div>

      <div
        id="auth-tabpanel"
        role="tabpanel"
        aria-labelledby={activeTab === 'login' ? 'auth-tab-login' : 'auth-tab-register'}
      >
        {errorMessage && (
          <div
            role="alert"
            className="mb-5 flex items-start gap-3 p-3.5 rounded-lg bg-status-dangerSoft dark:bg-rose-950/30 border border-status-danger/25 dark:border-rose-800/50 text-status-danger dark:text-rose-300 text-sm"
          >
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div
            role="status"
            className="mb-5 flex items-start gap-3 p-3.5 rounded-lg bg-status-successSoft dark:bg-emerald-950/30 border border-status-success/25 dark:border-emerald-800/50 text-status-success dark:text-emerald-300 text-sm"
          >
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{successMessage}</span>
          </div>
        )}

        <GoogleOAuthButton
          isGoogleLoading={isGoogleLoading}
          disabled={isGoogleLoading || isLoading}
          onClick={handleGoogleLogin}
        />

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-neutral-border dark:border-dark-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white dark:bg-dark-surface px-3 text-ink-muted dark:text-dark-muted">
              or continue with email
            </span>
          </div>
        </div>

        <AuthCredentialsForm
          activeTab={activeTab}
          name={name}
          email={email}
          password={password}
          confirmPassword={confirmPassword}
          showPassword={showPassword}
          isBusy={isLoading || isGoogleLoading}
          isSubmitting={isLoading}
          onNameChange={setName}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onConfirmPasswordChange={setConfirmPassword}
          onTogglePassword={() => setShowPassword((prev) => !prev)}
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex flex-col bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
      <Header />
      <main id="main-content" className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6">
        <Suspense
          fallback={
            <div role="status" className="py-12 flex items-center justify-center">
              <Loader2 className="w-7 h-7 animate-spin text-brand-700 dark:text-brand-400" />
              <span className="sr-only">Loading authentication form</span>
            </div>
          }
        >
          <LoginFormContent />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
