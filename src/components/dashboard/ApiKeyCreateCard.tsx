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
      className="bg-success-soft border border-success-edge/40 rounded-md p-5"
    >
      <output aria-live="polite" className="sr-only">
        {copiedKey ? 'API secret key copied to clipboard.' : 'API key generated.'}
      </output>
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        <div className="text-accent-ink shrink-0 self-start">
          <Check className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg text-ink">
            API Key Generated
          </h2>
          <p className="text-xs text-ink-2 mt-1">
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
              className="min-h-[44px] font-mono text-base px-3.5 py-2 rounded-sm bg-surface/80 border border-rule-strong text-ink flex-1 min-w-0 select-all"
            />
            <button
              type="button"
              onClick={() => onCopy(secret)}
              aria-label="Copy generated API key"
              className="lift min-h-[44px] px-4 py-2 rounded-sm bg-accent hover:bg-accent-hover hover:shadow-glow text-on-accent font-semibold text-sm inline-flex items-center justify-center gap-2 shrink-0"
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
              className="min-h-[44px] px-3.5 py-2 rounded-sm border border-rule text-ink text-sm font-semibold hover:bg-surface"
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
    <div className="mb-6 p-5 rounded-md border border-rule">
      <h3 className="text-sm font-bold text-ink mb-4">Create New API Key</h3>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="new-key-name-input"
            className="block text-xs font-semibold text-ink-2 mb-1.5"
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
            className="w-full min-h-[44px] px-3.5 py-2 rounded-sm border border-rule-strong bg-surface/80 text-base text-ink"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <fieldset className="border-0 p-0 m-0 min-w-0">
            <legend className="block text-xs font-semibold text-ink-2 mb-2">
              Granular Scopes (RBAC)
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
                      className="w-4 h-4 rounded text-base text-accent-ink"
                    />
                    <span className="font-mono">{scopeItem.label}</span>
                  </label>
                );
              })}
            </div>
            {selectedScopes.length === 0 && (
              <p role="alert" className="text-xs font-medium text-danger mt-1.5">
                Select at least one scope to generate a key.
              </p>
            )}
          </fieldset>

          <div>
            <label
              htmlFor="key-expiry-select"
              className="block text-xs font-semibold text-ink-2 mb-1.5"
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
              className="w-full min-h-[44px] px-3 py-2 rounded-sm border border-rule-strong bg-surface/80 text-base text-ink"
            >
              {KEY_EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-ink-3 mt-2">
              A <code>key.expiring_soon</code> webhook fires 7 days before expiration.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 pt-2">
          <button
            type="submit"
            disabled={isGeneratingKey || selectedScopes.length === 0}
            className="lift min-h-[44px] px-4 py-2 rounded-sm bg-accent hover:bg-accent-hover hover:shadow-glow text-on-accent font-semibold text-sm inline-flex items-center gap-2 disabled:opacity-60"
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
            className="min-h-[44px] px-4 py-2 rounded-sm border border-rule text-sm font-semibold hover:bg-sunken"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
