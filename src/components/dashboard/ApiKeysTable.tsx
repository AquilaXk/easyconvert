import React from 'react';
import { Key } from 'lucide-react';
import type { ApiKey } from '@/lib/api-keys/types';

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

export function ApiKeysTable({
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
        <Key
          className="w-9 h-9 text-ink-muted dark:text-dark-muted mx-auto mb-2.5"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-brand-950 dark:text-white">
          No API keys created yet
        </p>
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
            <th scope="col" className="pb-3 pr-4 font-semibold">
              Name &amp; Scopes
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              Key Prefix
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              Created
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              Expires
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              Last Used
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              Status
            </th>
            <th scope="col" className="pb-3 font-semibold text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-border dark:divide-dark-border">
          {apiKeys.map((key) => {
            const isActive = key.status === 'active';
            const isConfirming = revokingKeyId === key.id;
            return (
              <tr
                key={key.id}
                className="hover:bg-neutral-scaffold/40 dark:hover:bg-dark-elevated/40"
              >
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
                  {!isActive && (
                    <span className="text-xs text-ink-muted dark:text-dark-muted">Revoked</span>
                  )}
                  {isActive && isConfirming && (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onConfirmRevoke(key.id)}
                        aria-label={`Confirm revoking API key ${key.name}`}
                        className="min-h-[44px] px-3 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => onRequestRevoke(null)}
                        aria-label={`Cancel revoking API key ${key.name}`}
                        className="min-h-[44px] px-3 rounded-md border border-neutral-border dark:border-dark-border text-xs font-semibold text-ink-secondary dark:text-dark-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
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
                      className="min-w-[44px] min-h-[44px] px-3 rounded-md border border-neutral-border dark:border-dark-border text-xs text-status-danger dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 transition-colors"
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
