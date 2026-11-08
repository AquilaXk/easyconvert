'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthErrorNotice, AuthSuccessNotice } from '@/components/auth/AuthNotices';
import { CONTROL_HEIGHT, validateRegistrationInput } from '@/components/auth/AuthForms';
import { useFragmentToken } from '@/components/auth/useFragmentToken';
import { useAuthErrorWording } from '@/components/i18n/error-wording';

const LINK_CLASS = 'inline-flex min-h-6 items-center font-medium text-accent-ink hover:underline rounded-xs';
const INPUT_CLASS = `${CONTROL_HEIGHT} w-full px-2.5 rounded-xs border border-rule-strong bg-sunken text-ink text-base transition-colors`;
const LABEL_CLASS = 'block text-sm font-medium text-ink-2 mb-1';

export default function ResetPasswordPageView() {
  const t = useTranslations('auth.reset');
  const tAuth = useTranslations('auth');
  const tForm = useTranslations('auth.form');
  const authErrorWording = useAuthErrorWording();
  const { ready, token } = useFragmentToken();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const problem = validateRegistrationInput(password, confirmPassword);
    if (problem) {
      setError(tAuth(`messages.${problem}`));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError(authErrorWording(await res.json().catch(() => ({})), res.status));
      }
    } catch {
      setError(tAuth('messages.connection'));
    }
    setSaving(false);
  };

  if (!ready) return <AuthShell heading={t('heading')}>{null}</AuthShell>;

  if (done) {
    return (
      <AuthShell heading={t('heading')}>
        <AuthSuccessNotice>{t('done')}</AuthSuccessNotice>
        <p className="text-center text-sm">
          <Link href="/auth" className={LINK_CLASS}>
            {t('toSignIn')}
          </Link>
        </p>
      </AuthShell>
    );
  }

  if (!token) {
    return (
      <AuthShell heading={t('heading')}>
        <AuthErrorNotice>{t('noToken')}</AuthErrorNotice>
        <p className="text-center text-sm">
          <Link href="/auth/forgot-password" className={LINK_CLASS}>
            {t('requestNew')}
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading={t('heading')} intro={t('intro')}>
      {error && <AuthErrorNotice>{error}</AuthErrorNotice>}
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
        <div>
          <label htmlFor="reset-password" className={LABEL_CLASS}>
            {t('newPassword')}
          </label>
          <div className="relative">
            <input
              id="reset-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${INPUT_CLASS} pr-9 [@media(pointer:coarse)]:pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? tForm('hidePassword') : tForm('showPassword')}
              className="absolute inset-y-0 right-0 w-8 [@media(pointer:coarse)]:w-11 flex items-center justify-center rounded-xs text-ink-3 hover:text-ink transition-colors"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label htmlFor="reset-confirm-password" className={LABEL_CLASS}>
            {tForm('confirmPassword')}
          </label>
          <input
            id="reset-confirm-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <button
          type="submit"
          disabled={saving}
          className={`${CONTROL_HEIGHT} w-full flex items-center justify-center px-2.5 rounded-xs bg-accent text-on-accent hover:bg-accent-hover text-sm font-medium transition-colors disabled:opacity-60`}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>{t('submit')}</span>}
        </button>
      </form>
    </AuthShell>
  );
}
