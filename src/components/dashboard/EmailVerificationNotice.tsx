'use client';

import React, { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Mail } from 'lucide-react';
import { useAuthErrorWording } from '../i18n/error-wording';

/**
 * Tells a signed-in account whose email address is not confirmed that password reset mails do not reach it yet, with a link
 * that sends the confirmation mail again. It shows nothing when mail is not configured or the address is confirmed.
 */
export function EmailVerificationNotice({
  initial,
}: Readonly<{ initial?: { enabled: boolean; verified: boolean } }> = {}) {
  const t = useTranslations('dashboard.emailNotice');
  const locale = useLocale();
  const authErrorWording = useAuthErrorWording();
  const [unverified, setUnverified] = useState(
    initial ? initial.enabled && !initial.verified : false
  );
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'sent' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (initial !== undefined) return;
    let cancelled = false;
    fetch('/api/auth/email-verification')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { enabled?: unknown; verified?: unknown } | null) => {
        if (!cancelled) setUnverified(data?.enabled === true && data.verified === false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initial]);

  if (!unverified) return null;

  const resend = async () => {
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/email-verification/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      setMessage(
        res.status === 202
          ? { kind: 'sent', text: t('sent') }
          : { kind: 'error', text: authErrorWording(await res.json().catch(() => ({})), res.status) }
      );
    } catch {
      setMessage({ kind: 'error', text: t('connection') });
    }
    setSending(false);
  };

  return (
    <div className="mb-6 px-4 py-3 rounded-md bg-sunken border border-rule text-sm text-ink-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Mail className="w-4 h-4 shrink-0 text-ink-3" aria-hidden="true" />
      <p className="min-w-0 flex-1">{t('text')}</p>
      <button
        type="button"
        onClick={() => void resend()}
        disabled={sending}
        className="font-medium text-accent-ink hover:underline rounded-xs disabled:opacity-60 min-h-[44px] [@media(pointer:fine)]:min-h-0"
      >
        {t('resend')}
      </button>
      {message && (
        <output aria-live="polite" className={`basis-full ${message.kind === 'error' ? 'text-danger' : 'text-success'}`}>
          {message.text}
        </output>
      )}
    </div>
  );
}
