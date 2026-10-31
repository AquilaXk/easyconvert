'use client';

import React, { Suspense } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { AuthCredentialsForm, GoogleOAuthButton } from '@/components/auth/AuthForms';
import { useAuthController } from '@/components/auth/useAuthController';

function LoginFormContent() {
  const {
    activeTab,
    email,
    password,
    confirmPassword,
    name,
    showPassword,
    isLoading,
    isGoogleLoading,
    errorMessage,
    successMessage,
    tabRefs,
    setEmail,
    setPassword,
    setConfirmPassword,
    setName,
    setShowPassword,
    handleTabSwitch,
    handleTabKeyDown,
    handleGoogleLogin,
    handleSubmit,
  } = useAuthController();

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
          ref={(el) => {
            tabRefs.current.login = el;
          }}
          id="auth-tab-login"
          role="tab"
          aria-selected={activeTab === 'login'}
          aria-controls="auth-tabpanel"
          tabIndex={activeTab === 'login' ? 0 : -1}
          type="button"
          onClick={() => handleTabSwitch('login')}
          onKeyDown={(event) => handleTabKeyDown(event, 'login')}
          className={`flex-1 min-h-[44px] px-3 py-2 text-sm font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 ${
            activeTab === 'login'
              ? 'bg-white dark:bg-dark-surface text-brand-700 dark:text-white shadow-sm'
              : 'text-ink-secondary dark:text-dark-muted hover:text-brand-950 dark:hover:text-white'
          }`}
        >
          Sign In
        </button>
        <button
          ref={(el) => {
            tabRefs.current.register = el;
          }}
          id="auth-tab-register"
          role="tab"
          aria-selected={activeTab === 'register'}
          aria-controls="auth-tabpanel"
          tabIndex={activeTab === 'register' ? 0 : -1}
          type="button"
          onClick={() => handleTabSwitch('register')}
          onKeyDown={(event) => handleTabKeyDown(event, 'register')}
          className={`flex-1 min-h-[44px] px-3 py-2 text-sm font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 ${
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
          <output
            aria-live="polite"
            className="mb-5 flex items-start gap-3 p-3.5 rounded-lg bg-status-successSoft dark:bg-emerald-950/30 border border-status-success/25 dark:border-emerald-800/50 text-status-success dark:text-emerald-300 text-sm"
          >
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{successMessage}</span>
          </output>
        )}

        <GoogleOAuthButton
          isGoogleLoading={isGoogleLoading}
          disabled={isGoogleLoading || isLoading}
          onClick={() => {
            void handleGoogleLogin();
          }}
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
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
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
            <output aria-live="polite" className="py-12 flex items-center justify-center">
              <Loader2 className="w-7 h-7 animate-spin text-brand-700 dark:text-brand-400" />
              <span className="sr-only">Loading authentication form</span>
            </output>
          }
        >
          <LoginFormContent />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
