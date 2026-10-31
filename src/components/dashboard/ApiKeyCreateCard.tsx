import React from 'react';
import { Check, Copy, Key, Loader2 } from 'lucide-react';
import type { ApiKeyScope } from '@/lib/api-keys/types';
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
  return (
    <section
      aria-label="Generated API key"
      className="bg-status-successSoft dark:bg-emerald-950/30 border border-status-success/40 dark:border-emerald-700/50 rounded-xl p-5 shadow-sm"
    >
      <output aria-live="polite" className="sr-only">
        {copiedKey ? 'API secret key copied to clipboard.' : 'API key generated.'}
      </output>
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
              className="min-h-[44px] font-mono text-base px-3.5 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-brand-950 dark:text-emerald-200 flex-1 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 select-all"
            />
            <button
              type="button"
              onClick={() => onCopy(secret)}
              aria-label="Copy generated API key"
              className="min-h-[44px] px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 transition-colors"
            >
              {copiedKey ? (
                <Check className="w-4 h-4" aria-hidden="true" />
              ) : (
                <Copy className="w-4 h-4" aria-hidden="true" />
              )}
              <span>{copiedKey ? 'Copied' : 'Copy Key'}</span>
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-[44px] px-3.5 py-2 rounded-md border border-neutral-border dark:border-dark-border text-brand-950 dark:text-dark-text text-sm font-semibold hover:bg-white dark:hover:bg-dark-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
            >
              Dismiss
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
  isGeneratingKey: boolean;
  onNameChange: (name: string) => void;
  onToggleScope: (scope: ApiKeyScope, checked: boolean) => void;
  onExpiryChange: (expiry: KeyExpiryOption) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}

export function CreateApiKeyForm({
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
            className="w-full min-h-[44px] px-3.5 py-2 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface text-base text-brand-950 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <fieldset className="border-0 p-0 m-0 min-w-0">
            <legend className="block text-xs font-semibold text-ink-secondary dark:text-dark-muted mb-2">
              Granular Scopes (RBAC)
            </legend>
            <div className="space-y-1.5">
              {RBAC_SCOPE_ITEMS.map((scopeItem) => {
                const checkboxId = `scope-checkbox-${scopeItem.id.replace(':', '-')}`;
                return (
                  <label
                    key={scopeItem.id}
                    htmlFor={checkboxId}
                    className="min-h-[44px] sm:min-h-[36px] flex items-center gap-2.5 text-xs cursor-pointer select-none text-brand-950 dark:text-dark-text"
                  >
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={selectedScopes.includes(scopeItem.id)}
                      onChange={(e) => onToggleScope(scopeItem.id, e.target.checked)}
                      className="w-4 h-4 rounded text-base text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
                    />
                    <span className="font-mono">{scopeItem.label}</span>
                  </label>
                );
              })}
            </div>
            {selectedScopes.length === 0 && (
              <p role="alert" className="text-xs font-medium text-status-danger dark:text-rose-400 mt-1.5">
                Select at least one scope to generate a key.
              </p>
            )}
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
              className="w-full min-h-[44px] px-3 py-2 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface text-base text-brand-950 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
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
            disabled={isGeneratingKey || selectedScopes.length === 0}
            className="min-h-[44px] px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 disabled:opacity-60"
          >
            {isGeneratingKey ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Key className="w-4 h-4" />
            )}
            <span>Create API Key</span>
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] px-4 py-2 rounded-md border border-neutral-border dark:border-dark-border text-sm font-semibold hover:bg-neutral-subtle dark:hover:bg-dark-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
