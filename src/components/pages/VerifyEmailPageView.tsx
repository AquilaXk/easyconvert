'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthErrorNotice, AuthSuccessNotice } from '@/components/auth/AuthNotices';
import { CONTROL_HEIGHT } from '@/components/auth/AuthForms';
import { useFragmentToken } from '@/components/auth/useFragmentToken';
import { useAuthErrorWording } from '@/components/i18n/error-wording';

const LINK_CLASS = 'font-medium text-accent-ink hover:underline rounded-xs';

export default function VerifyEmailPageView() {
  const t = useTranslations('auth.verify');
  const tAuth = useTranslations('auth');
  const authErrorWording = useAuthErrorWording();
  const { ready, token } = useFragmentToken();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The link only opens this page; the address is confirmed by the button, so a mail scanner that opens links cannot do it.
  const handleConfirm = async () => {
    setError(null);
    setConfirming(true);
    try {
      const res = await fetch('/api/auth/email-verification/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError(authErrorWording(await res.json().catch(() => ({})), res.status));
      }
    } catch {
      setError(tAuth('messages.connection'));
    }
    setConfirming(false);
  };

  if (!ready) return <AuthShell heading={t('heading')}>{null}</AuthShell>;

  return (
    <AuthShell heading={t('heading')} intro={done || !token ? undefined : t('intro')}>
      {error && <AuthErrorNotice>{error}</AuthErrorNotice>}
      {!token && !done && <AuthErrorNotice>{t('noToken')}</AuthErrorNotice>}
      {done && <AuthSuccessNotice>{t('done')}</AuthSuccessNotice>}
      {token && !done && (
        <button
          type="button"
          disabled={confirming}
          onClick={() => void handleConfirm()}
          className={`${CONTROL_HEIGHT} w-full flex items-center justify-center px-2.5 rounded-xs bg-accent text-on-accent hover:bg-accent-hover text-sm font-medium transition-colors disabled:opacity-60`}
        >
          {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>{t('submit')}</span>}
        </button>
      )}
      <p className="mt-5 text-center text-sm">
        <Link href={done ? '/dashboard' : '/auth'} className={LINK_CLASS}>
          {done ? t('toDashboard') : t('toSignIn')}
        </Link>
      </p>
    </AuthShell>
  );
}
