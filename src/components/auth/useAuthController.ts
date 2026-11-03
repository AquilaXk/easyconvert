'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { applySessionChange, type SessionUser } from '@/lib/viewer-plan';
import { TERMS_VERSION } from '@/lib/legal/documents';
import { useAuthErrorWording } from '../i18n/error-wording';
import {
  resolveOAuthErrorKey,
  validateRegistrationInput,
  type AuthTab,
} from './AuthForms';

export const AUTH_TABS: readonly AuthTab[] = ['login', 'register'];

/** What `/api/auth/login` and `/api/auth/register` answer: the session's user on success (both routes always send it), else a refusal with its `code`. */
type AuthAnswer = { success: true; user: SessionUser } | { success: false; code?: string; error?: string };

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
  const tabRefs = useRef<Record<AuthTab, HTMLButtonElement | null>>({
    login: null,
    register: null,
  });

  useEffect(() => {
    setActiveTab(tabParam === 'register' ? 'register' : 'login');
  }, [tabParam]);

  useEffect(() => {
    const key = resolveOAuthErrorKey(urlError);
    setError(key ? t(`oauthErrors.${key}`) : null);
  }, [urlError, t]);

  const handleTabSwitch = (tab: AuthTab) => {
    setActiveTab(tab);
    setError(null);
    setSuccessMessage(null);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: AuthTab) => {
    const currentIndex = AUTH_TABS.indexOf(currentTab);
    let nextTab: AuthTab | null = null;

    if (event.key === 'ArrowRight') {
      nextTab = AUTH_TABS[(currentIndex + 1) % AUTH_TABS.length];
    } else if (event.key === 'ArrowLeft') {
      nextTab = AUTH_TABS[(currentIndex - 1 + AUTH_TABS.length) % AUTH_TABS.length];
    } else if (event.key === 'Home') {
      nextTab = AUTH_TABS[0];
    } else if (event.key === 'End') {
      nextTab = AUTH_TABS.at(-1) ?? null;
    }

    if (nextTab) {
      event.preventDefault();
      handleTabSwitch(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!email || !password) {
      setError(t('messages.missingFields'));
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

    try {
      const endpoint = activeTab === 'register' ? '/api/auth/register' : '/api/auth/login';
      const acceptance = acceptedTerms ? { acceptedTermsVersion: TERMS_VERSION } : {};
      const payload = activeTab === 'register' ? { email, password, name, ...acceptance } : { email, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as AuthAnswer;

      if (!res.ok || !data.success) {
        setError(authErrorWording(data, res.status));
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
    } catch {
      setError(t('messages.connection'));
      setIsLoading(false);
    }
  };

  return {
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
  };
}
