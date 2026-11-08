'use client';

import React, { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthErrorNotice, AuthSuccessNotice } from '@/components/auth/AuthNotices';
import { CONTROL_HEIGHT } from '@/components/auth/AuthForms';
import { useAuthErrorWording } from '@/components/i18n/error-wording';

const LINK_CLASS = 'inline-flex min-h-6 items-center font-medium text-accent-ink hover:underline rounded-xs';

export default function ForgotPasswordPageView() {
  const t = useTranslations('auth.forgot');
  const tForm = useTranslations('auth.form');
  const locale = useLocale();
  const authErrorWording = useAuthErrorWording();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSending(true);
    try {
      const res = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, locale }),
      });
      if (res.status === 202) {
        setSent(true);
      } else {
        setError(authErrorWording(await res.json().catch(() => ({})), res.status));
      }
    } catch {
      setError(t('connection'));
    }
    setSending(false);
  };

  return (
    <AuthShell heading={t('heading')} intro={sent ? undefined : t('intro')}>
      {error && <AuthErrorNotice>{error}</AuthErrorNotice>}
      {sent ? (
        <AuthSuccessNotice>{t('sent')}</AuthSuccessNotice>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
          <div>
            <label htmlFor="forgot-email" className="block text-sm font-medium text-ink-2 mb-1">
              {tForm('email')}
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={tForm('emailPlaceholder')}
              className={`${CONTROL_HEIGHT} w-full px-2.5 rounded-xs border border-rule-strong bg-sunken text-ink text-base transition-colors`}
            />
          </div>
          <button
            type="submit"
            disabled={sending}
            className={`${CONTROL_HEIGHT} w-full flex items-center justify-center px-2.5 rounded-xs bg-accent text-on-accent hover:bg-accent-hover text-sm font-medium transition-colors disabled:opacity-60`}
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>{t('submit')}</span>}
          </button>
        </form>
      )}
      <p className="mt-5 text-center text-sm">
        <Link href="/auth" className={LINK_CLASS}>
          {t('backToSignIn')}
        </Link>
      </p>
    </AuthShell>
  );
}
