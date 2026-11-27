'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import type { ApiKey } from '@/lib/api-keys/types';
import { ConfirmDialog } from './ConfirmDialog';

/** The confirmation that deletes an API key: the person types the name of the key, and a failure stays in the dialog for another try. */
export function DeleteApiKeyDialog({
  apiKey,
  pending,
  error,
  onConfirm,
  onClose,
}: Readonly<{
  apiKey: ApiKey | undefined;
  pending: boolean;
  error: string | null;
  onConfirm: (id: string) => void;
  onClose: () => void;
}>) {
  const t = useTranslations('dashboard.keys.deleteDialog');
  return (
    <ConfirmDialog
      open={apiKey !== undefined}
      title={t('title')}
      warning={t('warning')}
      details={
        apiKey && (
          <dl className="px-3.5 py-3 rounded-sm bg-sunken border border-rule text-sm space-y-1">
            <div className="flex gap-2">
              <dt className="text-ink-3 shrink-0">{t('name')}</dt>
              <dd className="font-semibold text-ink break-all">{apiKey.name}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-3 shrink-0">{t('prefix')}</dt>
              <dd className="font-mono text-xs text-ink-2 break-all pt-0.5">{apiKey.prefix}</dd>
            </div>
          </dl>
        )
      }
      phrase={
        apiKey && {
          value: apiKey.name,
          label: t.rich('phraseLabel', { code: (chunks) => <code className="font-mono font-semibold text-ink break-words">{chunks}</code>, name: apiKey.name }),
        }
      }
      confirmLabel={t('confirm')}
      pendingLabel={t('pending')}
      cancelLabel={t('cancel')}
      closeLabel={t('close')}
      confirmIcon={<Trash2 aria-hidden="true" className="w-4 h-4" />}
      pending={pending}
      error={error}
      onConfirm={() => apiKey && onConfirm(apiKey.id)}
      onClose={onClose}
    />
  );
}
