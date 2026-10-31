'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  resolveOAuthErrorMessage,
  validateRegistrationInput,
  type AuthTab,
} from './AuthForms';

export const AUTH_TABS: readonly AuthTab[] = ['login', 'register'];

export function useAuthController() {
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
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    resolveOAuthErrorMessage(urlError)
  );
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const tabRefs = useRef<Record<AuthTab, HTMLButtonElement | null>>({
    login: null,
    register: null,
  });

  useEffect(() => {
    setActiveTab(tabParam === 'register' ? 'register' : 'login');
  }, [tabParam]);

  useEffect(() => {
    setErrorMessage(resolveOAuthErrorMessage(urlError));
  }, [urlError]);

  const handleTabSwitch = (tab: AuthTab) => {
    setActiveTab(tab);
    setErrorMessage(null);
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
      nextTab = AUTH_TABS[AUTH_TABS.length - 1];
    }

    if (nextTab) {
      event.preventDefault();
      handleTabSwitch(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
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
        setErrorMessage(
          data.error || 'Authentication failed. Check your credentials and try again.'
        );
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

  return {
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
  };
}
