import React from 'react';
import { Key } from 'lucide-react';
import type { ApiKey } from '@/lib/api-keys/types';

function KeyExpirationBadge({ expiresAt }: Readonly<{ expiresAt?: number }>) {
  if (!expiresAt) {
    return <span className="text-ink-3">Never</span>;
  }
  const now = Date.now();
  if (now > expiresAt) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-danger-soft text-danger border border-danger-edge">
        Expired
      </span>
    );
  }
  const msRemaining = expiresAt - now;
  const sevenDaysMs = 7 * 86400 * 1000;
  if (msRemaining <= sevenDaysMs) {
    const daysRemaining = Math.max(1, Math.ceil(msRemaining / (86400 * 1000)));
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-warning-soft text-warning border border-warning-edge">
        Expiring in {daysRemaining}d
      </span>
    );
  }
  return (
    <span className="text-ink-2">
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
      <div className="text-center py-12 border border-dashed border-rule-strong/60 rounded-sm">
        <Key
          className="w-9 h-9 text-ink-3 mx-auto mb-2.5"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-ink">
          No API keys created yet
        </p>
        <p className="text-xs text-ink-3 mt-1">
          Generate an API key to authenticate programmatic conversion requests.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto max-w-full">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-rule text-ink-3 text-xs uppercase">
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
        <tbody className="divide-y divide-rule">
          {apiKeys.map((key) => {
            const isActive = key.status === 'active';
            const isConfirming = revokingKeyId === key.id;
            return (
              <tr
                key={key.id}
                className="hover:bg-sunken/50"
              >
                <td className="py-3.5 pr-4">
                  <div className="font-semibold text-ink">{key.name}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {key.scopes && key.scopes.length > 0 ? (
                      key.scopes.map((scope) => (
                        <span
                          key={scope}
                          className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-sunken text-ink-2 border border-rule"
                        >
                          {scope}
                        </span>
                      ))
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-sunken text-ink-2 border border-rule">
                        all scopes (*)
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-3.5 pr-4 font-mono text-xs text-ink-2 whitespace-nowrap">
                  {key.prefix}
                </td>
                <td className="py-3.5 pr-4 text-xs text-ink-2 whitespace-nowrap">
                  {new Date(key.createdAt).toLocaleDateString()}
                </td>
                <td className="py-3.5 pr-4 text-xs whitespace-nowrap">
                  <KeyExpirationBadge expiresAt={key.expiresAt} />
                </td>
                <td className="py-3.5 pr-4 text-xs text-ink-2 whitespace-nowrap">
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                </td>
                <td className="py-3.5 pr-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-sm text-xs font-semibold border ${
                      isActive
                        ? 'bg-success-soft text-success border-success-edge'
                        : 'bg-danger-soft text-danger border-danger-edge'
                    }`}
                  >
                    {key.status.toUpperCase()}
                  </span>
                </td>
                <td className="py-3.5 text-right whitespace-nowrap">
                  {!isActive && (
                    <span className="text-xs text-ink-3">Revoked</span>
                  )}
                  {isActive && isConfirming && (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onConfirmRevoke(key.id)}
                        aria-label={`Confirm revoking API key ${key.name}`}
                        className="min-h-[44px] px-3 rounded-sm bg-danger hover:bg-danger text-on-accent text-xs font-semibold"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => onRequestRevoke(null)}
                        aria-label={`Cancel revoking API key ${key.name}`}
                        className="min-h-[44px] px-3 rounded-sm border border-rule text-xs font-semibold text-ink-2"
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
                      className="min-w-[44px] min-h-[44px] px-3 rounded-sm border border-rule text-xs text-danger hover:bg-danger-soft font-semibold transition-colors"
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
