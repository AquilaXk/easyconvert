import React from 'react';
import { Check, Clock, Copy, Key, Loader2, Plus } from 'lucide-react';
import type { ApiKey, ApiKeyScope, QuotaUsage } from '@/lib/api-keys/types';
import { IntegrationGuide } from './IntegrationGuide';
import {
  isKeyExpiryOption,
  KEY_EXPIRY_OPTIONS,
  type KeyExpiryOption,
} from './dashboard-types';

const RBAC_SCOPE_ITEMS: ReadonlyArray<{ id: ApiKeyScope; label: string }> = [
  { id: 'convert:write', label: 'convert:write (Upload & Convert)' },
  { id: 'convert:read', label: 'convert:read (Job Status & Polling)' },
  { id: 'storage:download', label: 'storage:download (Output Artifacts)' },
];

function KeyExpirationBadge({ expiresAt }: Readonly<{ expiresAt?: number }>) {
  if (!expiresAt) {
    return <span className="text-ink-muted dark:text-dark-muted">Never</span>;
  }
  const now = Date.now();
  if (now > expiresAt) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 border border-rose-300 dark:border-rose-800">
        Expired
      </span>
    );
  }
  const msRemaining = expiresAt - now;
  const sevenDaysMs = 7 * 86400 * 1000;
  if (msRemaining <= sevenDaysMs) {
    const daysRemaining = Math.max(1, Math.ceil(msRemaining / (86400 * 1000)));
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-300 dark:border-amber-800">
        Expiring in {daysRemaining}d
      </span>
    );
  }
  return (
    <span className="text-ink-secondary dark:text-dark-muted">
      {new Date(expiresAt).toLocaleDateString()}
    </span>
  );
}

interface QuotaSummaryStripProps {
  quota: QuotaUsage;
}

function QuotaSummaryStrip({ quota }: Readonly<QuotaSummaryStripProps>) {
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
          <span className="text-ink-muted dark:text-dark-muted text-sm">/ {quota.dailyLimit} allowed</span>
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
          <Clock className="w-5 h-5 text-brand-700 dark:text-brand-400" />
          <span>00:00 UTC</span>
        </div>
        <p className="mt-2 text-xs text-ink-muted dark:text-dark-muted">
          Daily API counters reset automatically at midnight UTC.
        </p>
      </div>
    </div>
  );
}

interface CreateApiKeyFormProps {
  newKeyName: string;
  selectedScopes: ApiKeyScope[];
  keyExpiry: KeyExpiryOption;
  isGeneratingKey: boolean;
  onNameChange: (name: string) => void;
  onToggleScope: (scope: ApiKeyScope, checked: boolean) => void;
  onExpiryChange: (expiry: KeyExpiryOption) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}

function CreateApiKeyForm({
  newKeyName,
  selectedScopes,
  keyExpiry,
  isGeneratingKey,
  onNameChange,
  onToggleScope,
  onExpiryChange,
  onSubmit,
  onCancel,
}: Readonly<CreateApiKeyFormProps>) {
  return (
    <div className="mb-6 p-5 rounded-xl bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border">
      <h3 className="text-sm font-bold text-brand-950 dark:text-white mb-4">Create New API Key</h3>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="new-key-name-input"
            className="block text-xs font-semibold text-ink-secondary dark:text-dark-muted mb-1.5"
          >
            Key Name
          </label>
          <input
            id="new-key-name-input"
            type="text"
            required
            placeholder="Production Backend Worker"
            value={newKeyName}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface text-base text-brand-950 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-700"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <fieldset>
            <legend className="block text-xs font-semibold text-ink-secondary dark:text-dark-muted mb-2">
              Granular Scopes (RBAC)
            </legend>
            <div className="space-y-2">
              {RBAC_SCOPE_ITEMS.map((scopeItem) => {
                const checkboxId = `scope-checkbox-${scopeItem.id.replace(':', '-')}`;
                return (
                  <label
                    key={scopeItem.id}
                    htmlFor={checkboxId}
                    className="min-h-[36px] flex items-center gap-2.5 text-xs cursor-pointer select-none text-brand-950 dark:text-dark-text"
                  >
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={selectedScopes.includes(scopeItem.id)}
                      onChange={(e) => onToggleScope(scopeItem.id, e.target.checked)}
                      className="w-4 h-4 rounded text-base text-brand-700 focus:ring-brand-700"
                    />
                    <span className="font-mono">{scopeItem.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label
              htmlFor="key-expiry-select"
              className="block text-xs font-semibold text-ink-secondary dark:text-dark-muted mb-1.5"
            >
              Key Expiration
            </label>
            <select
              id="key-expiry-select"
              value={keyExpiry}
              onChange={(e) => {
                if (isKeyExpiryOption(e.target.value)) {
                  onExpiryChange(e.target.value);
                }
              }}
              className="w-full min-h-[44px] px-3 py-2 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface text-base text-brand-950 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-700"
            >
              {KEY_EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-ink-muted dark:text-dark-muted mt-2">
              A <code>key.expiring_soon</code> webhook fires 7 days before expiration.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 pt-2">
          <button
            type="submit"
            disabled={isGeneratingKey}
            className="min-h-[44px] px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm inline-flex items-center gap-2 disabled:opacity-60"
          >
            {isGeneratingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
            <span>Create API Key</span>
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] px-4 py-2 rounded-md border border-neutral-border dark:border-dark-border text-sm font-semibold hover:bg-neutral-subtle dark:hover:bg-dark-surface"
          >
            Cancel
          </button>
        </div>
      </form>
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

function GeneratedSecretBanner({
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
  return (
    <div
      role="status"
      className="bg-status-successSoft dark:bg-emerald-950/30 border border-status-success/40 dark:border-emerald-700/50 rounded-xl p-5 shadow-sm"
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        <div className="p-2 rounded-lg bg-status-success text-white shrink-0 self-start">
          <Check className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-brand-950 dark:text-emerald-200">
            API Key Generated
          </h2>
          <p className="text-xs text-ink-secondary dark:text-emerald-300/80 mt-1">
            Copy this secret key now. Only the key hash is stored and the secret is not shown again.
          </p>

          <div className="mt-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <label htmlFor="generated-secret-key-input" className="sr-only">
              Generated API secret key
            </label>
            <input
              id="generated-secret-key-input"
              type="text"
              readOnly
              value={secret}
              className="min-h-[44px] font-mono text-base px-3.5 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-950 dark:text-emerald-200 flex-1 min-w-0 outline-none select-all"
            />
            <button
              type="button"
              onClick={() => onCopy(secret)}
              aria-label="Copy generated API key"
              className="min-h-[44px] px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 shrink-0 transition-colors"
            >
              {copiedKey ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
              <span>{copiedKey ? 'Copied' : 'Copy Key'}</span>
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-[44px] px-3.5 py-2 rounded-md border border-neutral-border dark:border-dark-border text-brand-950 dark:text-dark-text text-sm font-semibold hover:bg-white dark:hover:bg-dark-surface"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ApiKeysTable({
  apiKeys,
  revokingKeyId,
  onRequestRevoke,
  onConfirmRevoke,
}: Readonly<{
  apiKeys: ApiKey[];
  revokingKeyId: string | null;
  onRequestRevoke: (id: string | null) => void;
  onConfirmRevoke: (id: string) => void;
}>) {
  if (apiKeys.length === 0) {
    return (
      <div className="text-center py-12 border border-neutral-border dark:border-dark-border rounded-xl bg-neutral-scaffold/50 dark:bg-dark-scaffold/40">
        <Key className="w-9 h-9 text-ink-muted dark:text-dark-muted mx-auto mb-2.5" aria-hidden="true" />
        <p className="text-sm font-semibold text-brand-950 dark:text-white">No API keys created yet</p>
        <p className="text-xs text-ink-muted dark:text-dark-muted mt-1">
          Generate an API key to authenticate programmatic conversion requests.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto max-w-full">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-border dark:border-dark-border text-ink-muted dark:text-dark-muted text-xs uppercase">
            <th scope="col" className="pb-3 pr-4 font-semibold">Name &amp; Scopes</th>
            <th scope="col" className="pb-3 pr-4 font-semibold">Key Prefix</th>
            <th scope="col" className="pb-3 pr-4 font-semibold">Created</th>
            <th scope="col" className="pb-3 pr-4 font-semibold">Expires</th>
            <th scope="col" className="pb-3 pr-4 font-semibold">Last Used</th>
            <th scope="col" className="pb-3 pr-4 font-semibold">Status</th>
            <th scope="col" className="pb-3 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
          {apiKeys.map((key) => {
            const isActive = key.status === 'active';
            const isConfirming = revokingKeyId === key.id;
            return (
              <tr key={key.id} className="hover:bg-neutral-scaffold/40 dark:hover:bg-dark-elevated/40">
                <td className="py-3.5 pr-4">
                  <div className="font-semibold text-brand-950 dark:text-white">{key.name}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {key.scopes && key.scopes.length > 0 ? (
                      key.scopes.map((scope) => (
                        <span
                          key={scope}
                          className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted border border-neutral-border dark:border-dark-border"
                        >
                          {scope}
                        </span>
                      ))
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted border border-neutral-border dark:border-dark-border">
                        all scopes (*)
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-3.5 pr-4 font-mono text-xs text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                  {key.prefix}
                </td>
                <td className="py-3.5 pr-4 text-xs text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                  {new Date(key.createdAt).toLocaleDateString()}
                </td>
                <td className="py-3.5 pr-4 text-xs whitespace-nowrap">
                  <KeyExpirationBadge expiresAt={key.expiresAt} />
                </td>
                <td className="py-3.5 pr-4 text-xs text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                </td>
                <td className="py-3.5 pr-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold border ${
                      isActive
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
                        : 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30'
                    }`}
                  >
                    {key.status.toUpperCase()}
                  </span>
                </td>
                <td className="py-3.5 text-right whitespace-nowrap">
                  {!isActive && <span className="text-xs text-ink-muted dark:text-dark-muted">Revoked</span>}
                  {isActive && isConfirming && (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onConfirmRevoke(key.id)}
                        aria-label={`Confirm revoking API key ${key.name}`}
                        className="min-h-[44px] px-3 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => onRequestRevoke(null)}
                        aria-label={`Cancel revoking API key ${key.name}`}
                        className="min-h-[44px] px-3 rounded-md border border-neutral-border dark:border-dark-border text-xs font-semibold text-ink-secondary dark:text-dark-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {isActive && !isConfirming && (
                    <button
                      type="button"
                      onClick={() => onRequestRevoke(key.id)}
                      aria-label={`Revoke API key ${key.name}`}
                      className="min-w-[44px] min-h-[44px] px-3 rounded-md border border-neutral-border dark:border-dark-border text-xs text-status-danger dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 font-semibold transition-colors"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
    <div id="dashboard-panel-api" role="tabpanel" aria-labelledby="dashboard-tab-api" className="space-y-6">
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
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm shadow-sm transition-colors self-start sm:self-auto"
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

      <IntegrationGuide sampleKeyDisplay={sampleKeyDisplay} onCopy={actions.onCopy} />
    </div>
  );
}
