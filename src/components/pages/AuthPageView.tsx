'use client';

import React, { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { AuthCredentialsForm, GoogleOAuthButton } from '@/components/auth/AuthForms';
import { useAuthController } from '@/components/auth/useAuthController';

function LoginFormContent() {
  const t = useTranslations('auth');
  const {
    activeTab,
    email,
    password,
    confirmPassword,
    name,
    acceptedTerms,
    showPassword,
    isLoading,
    isGoogleLoading,
    error,
    successMessage,
    tabRefs,
    setEmail,
    setPassword,
    setConfirmPassword,
    setName,
    setAcceptedTerms,
    setShowPassword,
    handleTabSwitch,
    handleTabKeyDown,
    handleGoogleLogin,
    handleSubmit,
  } = useAuthController();

  return (
    <div className="bg-surface max-w-md w-full rounded-md border border-rule shadow-elev-1 p-6 sm:p-8">
      <div className="mb-6">
        <h1 className="text-3xl text-ink">
          {activeTab === 'login' ? t('loginHeading') : t('registerHeading')}
        </h1>
        <p className="mt-1.5 text-sm text-ink-2">
          {t('intro')}
        </p>
      </div>

      <div
        role="tablist"
        aria-label={t('modeLabel')}
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
              ? 'bg-surface text-accent-ink ring-1 ring-inset ring-accent'
              : 'text-ink-2 hover:text-ink'
          }`}
        >
          {t('tabs.login')}
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
              ? 'bg-surface text-accent-ink ring-1 ring-inset ring-accent'
              : 'text-ink-2 hover:text-ink'
          }`}
        >
          {t('tabs.register')}
        </button>
      </div>

      <div
        id="auth-tabpanel"
        role="tabpanel"
        aria-labelledby={activeTab === 'login' ? 'auth-tab-login' : 'auth-tab-register'}
      >
        {error && (
          <div className="mb-5 flex items-start gap-3 p-3.5 rounded-md bg-danger-soft border border-danger-edge/25 text-danger text-sm">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p role="alert" className="min-w-0">{error}</p>
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
          <span>{t('emailDivider')}</span>
          <span aria-hidden="true" className="flex-1 border-t border-rule" />
        </div>

        <AuthCredentialsForm
          activeTab={activeTab}
          name={name}
          email={email}
          password={password}
          confirmPassword={confirmPassword}
          acceptedTerms={acceptedTerms}
          showPassword={showPassword}
          isBusy={isLoading || isGoogleLoading}
          isSubmitting={isLoading}
          onNameChange={setName}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onConfirmPasswordChange={setConfirmPassword}
          onAcceptedTermsChange={setAcceptedTerms}
          onTogglePassword={() => setShowPassword((prev) => !prev)}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        />
      </div>
    </div>
  );
}

export default function AuthPageView() {
  const t = useTranslations('auth');
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main id="main-content" className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6">
        <Suspense
          fallback={
            <output aria-live="polite" className="py-12 flex items-center justify-center">
              <Loader2 className="w-7 h-7 animate-spin text-accent-ink" />
              <span className="sr-only">{t('loading')}</span>
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
