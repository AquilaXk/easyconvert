'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { applySessionChange, type SessionUser } from '@/lib/viewer-plan';
import { TERMS_VERSION } from '@/lib/legal/documents';
import { useAuthErrorWording } from '../i18n/error-wording';
import {
  isEmailCodeInput,
  resolveOAuthErrorKey,
  validateRegistrationInput,
  type AuthStep,
  type AuthTab,
} from './AuthForms';

/** What `/api/auth/login` and `/api/auth/register` answer: the session's user on success (both routes always send it), else a refusal with its `code`. */
type AuthAnswer = { success: true; user: SessionUser } | { success: false; code?: string; error?: string };

/** The code of the refusal that asks an account of the old kind for the code mailed to its address (`POST /api/auth/login`). */
const EMAIL_VERIFICATION_REQUIRED = 'email_verification_required';

export function useAuthController() {
  const t = useTranslations('auth');
  const locale = useLocale();
  const authErrorWording = useAuthErrorWording();
  const oauthErrorMessage = (urlError: string | null): string | null => {
    const key = resolveOAuthErrorKey(urlError);
    return key ? t(`oauthErrors.${key}`) : null;
  };
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const urlError = searchParams.get('error');

  const [activeTab, setActiveTab] = useState<AuthTab>(
    tabParam === 'register' ? 'register' : 'login'
  );
  const [step, setStep] = useState<AuthStep>('start');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(() => oauthErrorMessage(urlError));
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab(tabParam === 'register' ? 'register' : 'login');
  }, [tabParam]);

  useEffect(() => {
    const key = resolveOAuthErrorKey(urlError);
    setError(key ? t(`oauthErrors.${key}`) : null);
  }, [urlError, t]);

  const backToStart = () => {
    setStep('start');
    setCode('');
    setError(null);
    setSuccessMessage(null);
  };

  const handleTabSwitch = (tab: AuthTab) => {
    setActiveTab(tab);
    backToStart();
  };

  const handleGoogleLogin = async () => {
    if (activeTab === 'register' && !acceptedTerms) {
      setError(authErrorWording({ code: 'terms_not_accepted' }, 400));
      return;
    }
    setIsGoogleLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ locale });
      if (acceptedTerms) query.set('acceptedTermsVersion', TERMS_VERSION);
      const res = await fetch(`/api/auth/google/url?${query}`);
      const data = await res.json();
      if (data.success && data.url) {
        window.location.href = data.url;
        return;
      }
      setError(data.code ? authErrorWording(data, res.status) : t('messages.googleFailed'));
      setIsGoogleLoading(false);
    } catch {
      setError(t('messages.googleNetwork'));
      setIsGoogleLoading(false);
    }
  };

  /** Posts `payload` as JSON; the answer with its status, or null (and the connection message shown) when the request did not get through. */
  const post = async (endpoint: string, payload: Record<string, unknown>) => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { res, data: (await res.json()) as AuthAnswer };
    } catch {
      setError(t('messages.connection'));
      return null;
    }
  };

  /** The first step of a sign-up: mails the code to the address and moves to the code step. */
  const requestRegistrationCode = async (resent: boolean) => {
    setIsLoading(true);
    const answer = await post('/api/auth/register/code', { email, locale });
    setIsLoading(false);
    if (!answer) return;
    if (!answer.res.ok || !answer.data.success) {
      setError(authErrorWording(answer.data, answer.res.status));
      return;
    }
    setStep('code');
    setCode('');
    setSuccessMessage(resent ? t('messages.codeResent') : t('messages.codeSentRegister', { email }));
  };

  /** A sign-in of an account whose address was never confirmed: the password was right, so the answer names the step and mails the code. */
  const signInAskingForCode = async (resent: boolean) => {
    setIsLoading(true);
    const answer = await post('/api/auth/login', { email, password, locale });
    setIsLoading(false);
    if (!answer) return;
    if (answer.data.success || answer.data.code !== EMAIL_VERIFICATION_REQUIRED) {
      setError(answer.data.success ? t('messages.connection') : authErrorWording(answer.data, answer.res.status));
      return;
    }
    setStep('code');
    setCode('');
    setSuccessMessage(resent ? t('messages.codeResent') : t('messages.codeSentLogin', { email }));
  };

  const resendCode = async () => {
    setError(null);
    setSuccessMessage(null);
    if (activeTab === 'register') await requestRegistrationCode(true);
    else await signInAskingForCode(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (step === 'start' && activeTab === 'register') {
      if (!email) {
        setError(t('messages.missingFields'));
        return;
      }
      if (!acceptedTerms) {
        setError(authErrorWording({ code: 'terms_not_accepted' }, 400));
        return;
      }
      await requestRegistrationCode(false);
      return;
    }

    if (!email || !password) {
      setError(t('messages.missingFields'));
      return;
    }

    if (step === 'code' && !isEmailCodeInput(code)) {
      setError(t('messages.codeFormat'));
      return;
    }

    if (activeTab === 'register') {
      const regProblem = validateRegistrationInput(password, confirmPassword);
      if (regProblem) {
        setError(t(`messages.${regProblem}`));
        return;
      }
    }

    setIsLoading(true);

    const endpoint = activeTab === 'register' ? '/api/auth/register' : '/api/auth/login';
    const acceptance = acceptedTerms ? { acceptedTermsVersion: TERMS_VERSION } : {};
    const withCode = step === 'code' ? { code } : {};
    const payload =
      activeTab === 'register' ? { email, password, name, locale, ...withCode, ...acceptance } : { email, password, locale, ...withCode };
    const answer = await post(endpoint, payload);
    if (!answer) {
      setIsLoading(false);
      return;
    }
    const { res, data } = answer;

    if (!res.ok || !data.success) {
      if (!data.success && data.code === EMAIL_VERIFICATION_REQUIRED) {
        setStep('code');
        setCode('');
        setSuccessMessage(t('messages.codeSentLogin', { email }));
      } else {
        setError(authErrorWording(data, res.status));
      }
      setIsLoading(false);
      return;
    }

    // The header and the queue keep their plan across the client-side navigation; the answer names the new session.
    applySessionChange(data.user);
    setSuccessMessage(activeTab === 'register' ? t('messages.created') : t('messages.signedIn'));
    setTimeout(() => {
      router.push('/dashboard');
      router.refresh();
    }, 500);
  };

  return {
    activeTab,
    step,
    code,
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
    setCode,
    setEmail,
    setPassword,
    setConfirmPassword,
    setName,
    setAcceptedTerms,
    setShowPassword,
    handleTabSwitch,
    handleGoogleLogin,
    handleSubmit,
    resendCode,
    backToStart,
  };
}
