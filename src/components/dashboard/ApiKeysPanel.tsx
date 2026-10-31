import React from 'react';
import { Clock, Plus } from 'lucide-react';
import type { ApiKey, ApiKeyScope, QuotaUsage } from '@/lib/api-keys/types';
import { CreateApiKeyForm, GeneratedSecretBanner } from './ApiKeyCreateCard';
import { ApiKeysTable } from './ApiKeysTable';
import { IntegrationGuide } from './IntegrationGuide';
import type { KeyExpiryOption } from './dashboard-types';

function QuotaSummaryStrip({ quota }: Readonly<{ quota: QuotaUsage }>) {
  const pct = quota.dailyLimit > 0 ? Math.min(100, (quota.usedToday / quota.dailyLimit) * 100) : 0;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
      <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-5 shadow-sm">
        <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
          Daily API Requests Used
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl sm:text-3xl font-bold text-brand-700 dark:text-brand-300">
            {quota.usedToday}
          </span>
          <span className="text-ink-muted dark:text-dark-muted text-sm">
            / {quota.dailyLimit} allowed
          </span>
        </div>
        <div className="mt-3 w-full bg-neutral-subtle dark:bg-dark-elevated rounded-full h-2 overflow-hidden">
          <div
            className="bg-brand-700 dark:bg-brand-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-5 shadow-sm">
        <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
          Remaining Quota
        </div>
        <div className="mt-2 text-2xl sm:text-3xl font-bold text-brand-950 dark:text-white">
          {quota.remaining}{' '}
          <span className="text-sm font-normal text-ink-muted dark:text-dark-muted">calls left</span>
        </div>
        <p className="mt-2 text-xs text-ink-muted dark:text-dark-muted">
          Authenticated REST requests with automatic TTL cleanup.
        </p>
      </div>

      <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-5 shadow-sm">
        <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
          Daily Reset
        </div>
        <div className="mt-2 flex items-center gap-2 text-xl font-bold text-brand-950 dark:text-white">
          <Clock className="w-5 h-5 text-brand-700 dark:text-brand-400" aria-hidden="true" />
          <span>00:00 UTC</span>
        </div>
        <p className="mt-2 text-xs text-ink-muted dark:text-dark-muted">
          Daily API counters reset automatically at midnight UTC.
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
  const sampleKeyDisplay = apiKeys.length > 0 ? apiKeys[0].prefix : 'ec_live_your_api_key_here';

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

      <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-lg font-bold text-brand-950 dark:text-white">API Secret Keys</h2>
            <p className="text-sm text-ink-secondary dark:text-dark-muted">
              Create and revoke scoped keys for backend scripts and webhook pipelines.
            </p>
          </div>

          <button
            type="button"
            onClick={actions.onOpenGenerateForm}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 transition-colors self-start sm:self-auto"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>Generate New Key</span>
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
