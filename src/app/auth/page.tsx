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
    <div className="glass sheen-edge max-w-md w-full rounded-md border border-rule p-6 sm:p-8">
      <div className="mb-6">
        <h1 className="text-3xl text-ink">
          {activeTab === 'login' ? 'Sign in to EasyConvert' : 'Create an EasyConvert account'}
        </h1>
        <p className="mt-1.5 text-sm text-ink-2">
          Manage developer API keys, webhooks, and conversion history.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Authentication mode"
        className="flex rounded-md bg-sunken p-1 mb-6 border border-rule"
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
          className={`flex-1 min-h-[44px] px-3 py-2 text-sm font-semibold rounded-sm transition-colors ${
            activeTab === 'login'
              ? 'bg-surface text-accent-ink'
              : 'text-ink-2 hover:text-ink'
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
          className={`flex-1 min-h-[44px] px-3 py-2 text-sm font-semibold rounded-sm transition-colors ${
            activeTab === 'register'
              ? 'bg-surface text-accent-ink'
              : 'text-ink-2 hover:text-ink'
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
            className="mb-5 flex items-start gap-3 p-3.5 rounded-md bg-danger-soft border border-danger-edge/25 text-danger text-sm"
          >
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <output
            aria-live="polite"
            className="mb-5 flex items-start gap-3 p-3.5 rounded-md bg-success-soft border border-success-edge/25 text-success text-sm"
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

        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-widest text-ink-3">
          <span aria-hidden="true" className="flex-1 border-t border-rule" />
          <span>or continue with email</span>
          <span aria-hidden="true" className="flex-1 border-t border-rule" />
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
    <div className="min-h-screen flex flex-col">
      <Header />
      <main id="main-content" className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6">
        <Suspense
          fallback={
            <output aria-live="polite" className="py-12 flex items-center justify-center">
              <Loader2 className="w-7 h-7 animate-spin text-accent-ink" />
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
