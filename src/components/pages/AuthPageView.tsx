'use client';

import React, { Suspense, useEffect } from 'react';
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
    setEmail,
    setPassword,
    setConfirmPassword,
    setName,
    setAcceptedTerms,
    setShowPassword,
    handleTabSwitch,
    handleGoogleLogin,
    handleSubmit,
  } = useAuthController();
  const otherTab = activeTab === 'login' ? 'register' : 'login';
  const registerTitle = t('registerDocumentTitle');

  useEffect(() => {
    if (activeTab !== 'register') return;
    const loginTitle = document.title;
    document.title = registerTitle;
    return () => {
      document.title = loginTitle;
    };
  }, [activeTab, registerTitle]);

  return (
    <div className="bg-surface max-w-md w-full border border-rule p-6">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-ink">
          {activeTab === 'login' ? t('loginHeading') : t('registerHeading')}
        </h1>
        <p className="mt-1 text-base text-ink-3">
          {t.rich(activeTab === 'login' ? 'switchToRegister' : 'switchToLogin', {
            link: (chunks) => (
              <button
                type="button"
                onClick={() => handleTabSwitch(otherTab)}
                className="font-medium text-accent-ink hover:underline rounded-xs"
              >
                {chunks}
              </button>
            ),
          })}
        </p>
      </div>

      <div className="mt-6">
        {error && (
          <div className="mb-5 flex items-start gap-3 p-3 rounded-xs bg-danger-soft border border-danger-edge/25 text-danger text-sm">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p role="alert" className="min-w-0">{error}</p>
          </div>
        )}

        {successMessage && (
          <output
            aria-live="polite"
            className="mb-5 flex items-start gap-3 p-3 rounded-xs bg-success-soft border border-success-edge/25 text-success text-sm"
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

        <div className="my-5 flex items-center gap-3 text-sm text-ink-3">
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
      <main id="main-content" className="flex-1 flex items-start justify-center pt-8 pb-12 px-6">
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
