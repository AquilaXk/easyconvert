import React from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Key, Loader2 } from 'lucide-react';
import type { ApiKeyScope } from '@/lib/api-keys/types';
import { Link } from '@/i18n/navigation';
import { LEGAL_DOCUMENTS } from '@/lib/legal/documents';
import {
  isKeyExpiryOption,
  KEY_EXPIRY_OPTIONS,
  type KeyExpiryOption,
} from './dashboard-types';

/** The scopes a new key can hold; each one's description is `dashboard.keys.scopes.<key>` in the messages. */
const RBAC_SCOPE_ITEMS: ReadonlyArray<{ id: ApiKeyScope; key: 'convertWrite' | 'convertRead' | 'storageDownload' }> = [
  { id: 'convert:write', key: 'convertWrite' },
  { id: 'convert:read', key: 'convertRead' },
  { id: 'storage:download', key: 'storageDownload' },
];

export function GeneratedSecretBanner({
  secret,
  copiedKey,
  onCopy,
  onDismiss,
}: Readonly<{
  secret: string;
  copiedKey: boolean;
  onCopy: (text: string) => void;
  onDismiss: () => void;
}>) {
  const t = useTranslations('dashboard.keys.generated');
  return (
    <section
      aria-label={t('label')}
      className="bg-success-soft border border-success-edge/40 rounded-md p-5"
    >
      <output aria-live="polite" className="sr-only">
        {copiedKey ? t('copiedAnnouncement') : t('generatedAnnouncement')}
      </output>
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        <div className="text-accent-ink shrink-0 self-start">
          <Check className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg text-ink">
            {t('heading')}
          </h2>
          <p className="text-xs text-ink-2 mt-1">
            {t('body')}
          </p>

          <div className="mt-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <label htmlFor="generated-secret-key-input" className="sr-only">
              {t('inputLabel')}
            </label>
            <input
              id="generated-secret-key-input"
              type="text"
              readOnly
              value={secret}
              className="min-h-[44px] font-mono text-base px-3.5 py-2 rounded-sm bg-surface/80 border border-rule-strong text-ink flex-1 min-w-0 select-all"
            />
            <button
              type="button"
              onClick={() => onCopy(secret)}
              aria-label={t('copyLabel')}
              className="btn-primary min-h-[44px] px-4 py-2 rounded-sm font-semibold text-sm inline-flex items-center justify-center gap-2 shrink-0"
            >
              {copiedKey ? (
                <Check className="w-4 h-4" aria-hidden="true" />
              ) : (
                <Copy className="w-4 h-4" aria-hidden="true" />
              )}
              <span>{copiedKey ? t('copied') : t('copy')}</span>
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-[44px] px-3.5 py-2 rounded-sm border border-rule text-ink text-sm font-semibold hover:bg-surface"
            >
              {t('dismiss')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

interface CreateApiKeyFormProps {
  newKeyName: string;
  selectedScopes: ApiKeyScope[];
  keyExpiry: KeyExpiryOption;
  acceptedTerms: boolean;
  isGeneratingKey: boolean;
  onNameChange: (name: string) => void;
  onToggleScope: (scope: ApiKeyScope, checked: boolean) => void;
  onExpiryChange: (expiry: KeyExpiryOption) => void;
  onAcceptedTermsChange: (value: boolean) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}

export function CreateApiKeyForm({
  newKeyName,
  selectedScopes,
  keyExpiry,
  acceptedTerms,
  isGeneratingKey,
  onNameChange,
  onToggleScope,
  onExpiryChange,
  onAcceptedTermsChange,
  onSubmit,
  onCancel,
}: Readonly<CreateApiKeyFormProps>) {
  const t = useTranslations('dashboard.keys');
  return (
    <div className="mb-6 p-5 rounded-md border border-rule">
      <h3 className="text-sm font-bold text-ink mb-4">{t('createHeading')}</h3>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="new-key-name-input"
            className="block text-xs font-semibold text-ink-2 mb-1.5"
          >
            {t('name')}
          </label>
          <input
            id="new-key-name-input"
            type="text"
            required
            placeholder={t('namePlaceholder')}
            value={newKeyName}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-sm border border-rule-strong bg-surface/80 text-base text-ink"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <fieldset className="border-0 p-0 m-0 min-w-0">
            <legend className="block text-xs font-semibold text-ink-2 mb-2">
              {t('scopesLegend')}
            </legend>
            <div className="space-y-1.5">
              {RBAC_SCOPE_ITEMS.map((scopeItem) => {
                const checkboxId = `scope-checkbox-${scopeItem.id.replace(':', '-')}`;
                return (
                  <label
                    key={scopeItem.id}
                    htmlFor={checkboxId}
                    className="min-h-[44px] sm:min-h-[36px] flex items-center gap-2.5 text-xs cursor-pointer select-none text-ink"
                  >
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={selectedScopes.includes(scopeItem.id)}
                      onChange={(e) => onToggleScope(scopeItem.id, e.target.checked)}
                      className="w-4 h-4 rounded-md text-base text-accent-ink"
                    />
                    <span className="font-mono">{t(`scopes.${scopeItem.key}`, { scope: scopeItem.id })}</span>
                  </label>
                );
              })}
            </div>
            {selectedScopes.length === 0 && (
              <p role="alert" className="text-xs font-medium text-danger mt-1.5">
                {t('scopesRequired')}
              </p>
            )}
          </fieldset>

          <div>
            <label
              htmlFor="key-expiry-select"
              className="block text-xs font-semibold text-ink-2 mb-1.5"
            >
              {t('expiry')}
            </label>
            <select
              id="key-expiry-select"
              value={keyExpiry}
              onChange={(e) => {
                if (isKeyExpiryOption(e.target.value)) {
                  onExpiryChange(e.target.value);
                }
              }}
              className="w-full min-h-[44px] px-3 py-2 rounded-sm border border-rule-strong bg-surface/80 text-base text-ink"
            >
              {KEY_EXPIRY_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`expiryChoices.${value}`)}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-ink-3 mt-2">
              {t.rich('expiryNote', { code: (chunks) => <code>{chunks}</code> })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 min-h-[44px]">
          <input
            id="new-key-accept-terms"
            type="checkbox"
            required
            checked={acceptedTerms}
            onChange={(e) => onAcceptedTermsChange(e.target.checked)}
            className="size-4 cursor-pointer"
          />
          <label htmlFor="new-key-accept-terms" className="text-sm text-ink cursor-pointer select-none">
            {t.rich('acceptTerms', {
              link: (chunks) => (
                <Link href={LEGAL_DOCUMENTS.terms.path} target="_blank" className="font-medium text-accent-ink hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 pt-2">
          <button
            type="submit"
            disabled={isGeneratingKey || selectedScopes.length === 0}
            className="btn-primary min-h-[44px] px-4 py-2 rounded-sm font-semibold text-sm inline-flex items-center gap-2 disabled:opacity-60"
          >
            {isGeneratingKey ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Key className="w-4 h-4" />
            )}
            <span>{t('create')}</span>
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] px-4 py-2 rounded-sm border border-rule text-sm font-semibold hover:bg-sunken"
          >
            {t('cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}
