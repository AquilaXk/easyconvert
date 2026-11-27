'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Trash2 } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import type { User } from '@/lib/auth/types';
import { BILLING_REFUSAL_CODES, isCodeOf } from '@/lib/refusal-codes';
import { applySessionChange } from '@/lib/viewer-plan';
import { useAuthErrorWording, useBillingErrorWording } from '../i18n/error-wording';
import { ConfirmDialog } from './ConfirmDialog';

const FIELD_CLASS =
  'mt-1.5 w-full min-h-[44px] px-3.5 py-2 rounded-sm bg-canvas border border-rule-strong text-base sm:text-sm text-ink';
const PRIMARY_BTN_CLASS =
  'btn-primary min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-sm text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
const DANGER_BTN_CLASS =
  'min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-sm bg-danger-soft text-danger border border-danger-edge text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';
const LABEL_CLASS = 'block text-sm font-medium leading-snug text-ink';
const MIN_NEW_PASSWORD_LENGTH = 8;
const CONFIRM_DELETE_TOKEN = 'DELETE';

async function readJsonPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function validatePasswordFields(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
): 'missing' | 'tooShort' | 'mismatch' | null {
  if (!currentPassword || !newPassword || !confirmPassword) return 'missing';
  if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) return 'tooShort';
  if (newPassword !== confirmPassword) return 'mismatch';
  return null;
}

function PasswordForm() {
  const t = useTranslations('dashboard.security.password');
  const authWording = useAuthErrorWording();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const problem = validatePasswordFields(currentPassword, newPassword, confirmPassword);
    if (problem) {
      setError(t(problem));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/password-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = await readJsonPayload(response);
      if (!response.ok) {
        setError(authWording(payload, response.status));
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSaved(true);
    } catch {
      setError(authWording({}, 500));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-md space-y-4">
      <div>
        <label htmlFor="account-current-password" className={LABEL_CLASS}>
          {t('currentLabel')}
        </label>
        <input
          id="account-current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={FIELD_CLASS}
        />
      </div>
      <div>
        <label htmlFor="account-new-password" className={LABEL_CLASS}>
          {t('newLabel')}
        </label>
        <input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className={FIELD_CLASS}
        />
      </div>
      <div>
        <label htmlFor="account-confirm-password" className={LABEL_CLASS}>
          {t('confirmLabel')}
        </label>
        <input
          id="account-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={FIELD_CLASS}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {saved && (
        <output aria-live="polite" className="block text-sm font-medium text-success">
          {t('saved')}
        </output>
      )}
      <button type="submit" disabled={busy} className={PRIMARY_BTN_CLASS}>
        <Lock aria-hidden="true" className="w-4 h-4" />
        <span>{busy ? t('submitting') : t('submit')}</span>
      </button>
    </form>
  );
}

function resolveDeleteError(
  status: number,
  payload: Record<string, unknown>,
  drainingMessage: string,
  fallback: string,
  authWording: (payload: unknown, status: number) => string,
  billingWording: (payload: unknown, status: number, fallback: string) => string
): string {
  if (status === 409) return drainingMessage;
  if (status === 502 || isCodeOf(BILLING_REFUSAL_CODES, payload.code)) {
    return billingWording(payload, status, fallback);
  }
  return authWording(payload, status);
}

function DeleteAccountDialog({
  user,
  open,
  onClose,
}: Readonly<{ user: User; open: boolean; onClose: () => void }>) {
  const t = useTranslations('dashboard.security.delete');
  const authWording = useAuthErrorWording();
  const billingWording = useBillingErrorWording();
  const router = useRouter();
  const isGoogle = user.provider === 'google';
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const body = isGoogle
      ? { confirm: CONFIRM_DELETE_TOKEN, confirmEmail: credential.trim() }
      : { confirm: CONFIRM_DELETE_TOKEN, password: credential };
    try {
      const response = await fetch('/api/auth/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await readJsonPayload(response);
      if (!response.ok) {
        setError(resolveDeleteError(response.status, payload, t('draining'), t('confirm'), authWording, billingWording));
        return;
      }
      applySessionChange(null);
      router.replace('/auth');
      router.refresh();
    } catch {
      setError(authWording({}, 500));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title={t('heading')}
      description={t('intro')}
      phrase={{
        value: CONFIRM_DELETE_TOKEN,
        inputId: 'account-delete-phrase',
        label: t.rich('confirmPhraseLabel', { code: (chunks) => <code className="font-mono font-semibold text-ink">{chunks}</code> }),
      }}
      confirmLabel={t('confirm')}
      pendingLabel={t('confirming')}
      cancelLabel={t('cancel')}
      closeLabel={t('close')}
      confirmIcon={<Trash2 aria-hidden="true" className="w-4 h-4" />}
      pending={busy}
      error={error}
      confirmBlocked={credential.trim().length === 0}
      onConfirm={() => void submit()}
      onClose={onClose}
    >
      <div>
        <label htmlFor="account-delete-credential" className={LABEL_CLASS}>
          {isGoogle ? t('confirmEmailLabel', { email: user.email }) : t('passwordLabel')}
        </label>
        <input
          id="account-delete-credential"
          type={isGoogle ? 'email' : 'password'}
          autoComplete={isGoogle ? 'email' : 'current-password'}
          value={credential}
          disabled={busy}
          onChange={(e) => setCredential(e.target.value)}
          className={FIELD_CLASS}
        />
      </div>
    </ConfirmDialog>
  );
}

/**
 * Security tab panel following the standard two-card security settings layout (nextjs/saas-starter MIT `security/page.tsx`
 * + reference converter SSO notice + modal account-deletion confirmation matching DlqPayloadDialog / dubinc/dub).
 */
export function AccountSecurityPanel({ user }: Readonly<{ user: User }>) {
  const t = useTranslations('dashboard.security');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  return (
    <div
      id="dashboard-panel-security"
      role="tabpanel"
      aria-labelledby="dashboard-tab-security"
      className="space-y-6"
    >
      <div className="border-t border-rule pt-6 sm:pt-8 space-y-6">
        <div className="border-b border-rule pb-5">
          <h2 className="text-xl sm:text-2xl text-ink">{t('heading')}</h2>
          <p className="text-sm text-ink-2 mt-1">{t('intro')}</p>
        </div>

        <section aria-labelledby="account-password-heading" className="p-5 rounded-md border border-rule space-y-4">
          <div>
            <h3 id="account-password-heading" className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Lock aria-hidden="true" className="w-4 h-4 text-accent-ink" />
              <span>{t('password.heading')}</span>
            </h3>
            <p className="mt-1 text-xs sm:text-sm text-ink-2">
              {user.provider === 'google' ? t('password.oauthNotice') : t('password.intro')}
            </p>
          </div>
          {user.provider !== 'google' && <PasswordForm />}
        </section>

        <section aria-labelledby="account-delete-heading" className="p-5 rounded-md border border-danger-edge bg-surface space-y-4">
          <div>
            <h3 id="account-delete-heading" className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Trash2 aria-hidden="true" className="w-4 h-4 text-danger" />
              <span>{t('delete.heading')}</span>
            </h3>
            <p className="mt-1 text-xs sm:text-sm text-ink-2">{t('delete.intro')}</p>
          </div>
          <div>
            <button type="button" onClick={() => setDeleteDialogOpen(true)} className={DANGER_BTN_CLASS}>
              <Trash2 aria-hidden="true" className="w-4 h-4" />
              <span>{t('delete.open')}</span>
            </button>
          </div>
        </section>
      </div>

      <DeleteAccountDialog user={user} open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} />
    </div>
  );
}
