import React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Clock, Plus } from 'lucide-react';
import type { ApiKey, ApiKeyScope, QuotaUsage } from '@/lib/api-keys/types';
import { CreateApiKeyForm, GeneratedSecretBanner } from './ApiKeyCreateCard';
import { ApiKeysTable } from './ApiKeysTable';
import { IntegrationGuide } from './IntegrationGuide';
import type { KeyExpiryOption } from './dashboard-types';

function QuotaSummaryStrip({ quota }: Readonly<{ quota: QuotaUsage }>) {
  const t = useTranslations('dashboard.quota');
  const format = useFormatter();
  const pct = quota.dailyLimit > 0 ? Math.min(100, (quota.usedToday / quota.dailyLimit) * 100) : 0;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
      <div className="border-t border-rule pt-5">
        <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
          {t('used')}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl sm:text-3xl font-bold text-accent-ink">
            {format.number(quota.usedToday)}
          </span>
          <span className="text-ink-3 text-sm">
            {t('allowed', { limit: quota.dailyLimit })}
          </span>
        </div>
        <div className="mt-3 w-full bg-rule rounded-full h-2 overflow-hidden">
          <div
            className="bg-accent h-2 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="border-t border-rule pt-5">
        <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
          {t('remaining')}
        </div>
        <div className="mt-2 text-2xl sm:text-3xl font-bold text-ink">
          {format.number(quota.remaining)}{' '}
          <span className="text-sm font-normal text-ink-3">{t('callsLeft')}</span>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          {t('remainingNote')}
        </p>
      </div>

      <div className="border-t border-rule pt-5">
        <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
          {t('reset')}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xl font-bold text-ink">
          <Clock className="w-5 h-5 text-accent-ink" aria-hidden="true" />
          <span>00:00 UTC</span>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          {t('resetNote')}
        </p>
      </div>
    </div>
  );
}

export interface ApiKeysPanelState {
  apiKeys: ApiKey[];
  quota: QuotaUsage | null;
  newKeyName: string;
  generatedSecret: string | null;
  isGeneratingKey: boolean;
  showGenerateForm: boolean;
  copiedKey: boolean;
  revokingKeyId: string | null;
  selectedScopes: ApiKeyScope[];
  keyExpiry: KeyExpiryOption;
}

export interface ApiKeysPanelActions {
  onOpenGenerateForm: () => void;
  onCloseGenerateForm: () => void;
  onDismissGeneratedSecret: () => void;
  onNameChange: (name: string) => void;
  onToggleScope: (scope: ApiKeyScope, checked: boolean) => void;
  onExpiryChange: (expiry: KeyExpiryOption) => void;
  onGenerateKey: (e: React.FormEvent) => void;
  onRequestRevoke: (id: string | null) => void;
  onConfirmRevoke: (id: string) => void;
  onCopy: (text: string) => void;
}

interface ApiKeysPanelProps {
  state: ApiKeysPanelState;
  actions: ApiKeysPanelActions;
}

export function ApiKeysPanel({ state, actions }: Readonly<ApiKeysPanelProps>) {
  const {
    apiKeys,
    quota,
    newKeyName,
    generatedSecret,
    isGeneratingKey,
    showGenerateForm,
    copiedKey,
    revokingKeyId,
    selectedScopes,
    keyExpiry,
  } = state;
  const t = useTranslations('dashboard.keys');
  const sampleKeyDisplay = generatedSecret || '$EASYCONVERT_API_KEY';

  return (
    <div
      id="dashboard-panel-api"
      role="tabpanel"
      aria-labelledby="dashboard-tab-api"
      className="space-y-6"
    >
      {quota && <QuotaSummaryStrip quota={quota} />}

      {generatedSecret && (
        <GeneratedSecretBanner
          secret={generatedSecret}
          copiedKey={copiedKey}
          onCopy={actions.onCopy}
          onDismiss={actions.onDismissGeneratedSecret}
        />
      )}

      <div className="border-t border-rule pt-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl text-ink">{t('heading')}</h2>
            <p className="text-sm text-ink-2">
              {t('intro')}
            </p>
          </div>

          <button
            type="button"
            onClick={actions.onOpenGenerateForm}
            className="btn-primary min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-sm font-semibold text-sm self-start sm:self-auto"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>{t('generate')}</span>
          </button>
        </div>

        {showGenerateForm && (
          <CreateApiKeyForm
            newKeyName={newKeyName}
            selectedScopes={selectedScopes}
            keyExpiry={keyExpiry}
            isGeneratingKey={isGeneratingKey}
            onNameChange={actions.onNameChange}
            onToggleScope={actions.onToggleScope}
            onExpiryChange={actions.onExpiryChange}
            onSubmit={actions.onGenerateKey}
            onCancel={actions.onCloseGenerateForm}
          />
        )}

        <ApiKeysTable
          apiKeys={apiKeys}
          revokingKeyId={revokingKeyId}
          onRequestRevoke={actions.onRequestRevoke}
          onConfirmRevoke={actions.onConfirmRevoke}
        />
      </div>

      <IntegrationGuide sampleKeyDisplay={sampleKeyDisplay} />
    </div>
  );
}
