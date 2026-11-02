import React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Key } from 'lucide-react';
import type { ApiKey } from '@/lib/api-keys/types';

const DATE_FORMAT = { dateStyle: 'medium' } as const;

function KeyExpirationBadge({ expiresAt }: Readonly<{ expiresAt?: number }>) {
  const t = useTranslations('dashboard.keys.table');
  const format = useFormatter();
  if (!expiresAt) {
    return <span className="text-ink-3">{t('noExpiry')}</span>;
  }
  const now = Date.now();
  if (now > expiresAt) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-danger-soft text-danger border border-danger-edge">
        {t('expired')}
      </span>
    );
  }
  const msRemaining = expiresAt - now;
  const sevenDaysMs = 7 * 86400 * 1000;
  if (msRemaining <= sevenDaysMs) {
    const daysRemaining = Math.max(1, Math.ceil(msRemaining / (86400 * 1000)));
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-warning-soft text-warning border border-warning-edge">
        {t('expiringIn', { days: daysRemaining })}
      </span>
    );
  }
  return (
    <span className="text-ink-2">
      {format.dateTime(new Date(expiresAt), DATE_FORMAT)}
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
  const t = useTranslations('dashboard.keys.table');
  const format = useFormatter();
  if (apiKeys.length === 0) {
    return (
      <div className="text-center py-12 border border-dashed border-rule rounded-sm">
        <Key
          className="w-9 h-9 text-ink-3 mx-auto mb-2.5"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-ink">
          {t('emptyHeading')}
        </p>
        <p className="text-xs text-ink-3 mt-1">
          {t('emptyBody')}
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
              {t('columns.name')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              {t('columns.prefix')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              {t('columns.created')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              {t('columns.expires')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              {t('columns.lastUsed')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-semibold">
              {t('columns.status')}
            </th>
            <th scope="col" className="pb-3 font-semibold text-right">
              {t('columns.actions')}
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
                          className="px-1.5 py-0.5 rounded-md text-[11px] bg-sunken text-ink-2 border border-rule"
                        >
                          {scope}
                        </span>
                      ))
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-md text-[11px] bg-sunken text-ink-2 border border-rule">
                        {t('allScopes')}
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-3.5 pr-4 font-mono text-xs text-ink-2 whitespace-nowrap">
                  {key.prefix}
                </td>
                <td className="py-3.5 pr-4 text-xs text-ink-2 whitespace-nowrap">
                  {format.dateTime(new Date(key.createdAt), DATE_FORMAT)}
                </td>
                <td className="py-3.5 pr-4 text-xs whitespace-nowrap">
                  <KeyExpirationBadge expiresAt={key.expiresAt} />
                </td>
                <td className="py-3.5 pr-4 text-xs text-ink-2 whitespace-nowrap">
                  {key.lastUsedAt ? format.dateTime(new Date(key.lastUsedAt), DATE_FORMAT) : t('neverUsed')}
                </td>
                <td className="py-3.5 pr-4 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-sm text-xs font-semibold border ${
                      isActive
                        ? 'bg-success-soft text-success border-success-edge'
                        : 'bg-danger-soft text-danger border-danger-edge'
                    }`}
                  >
                    {t(isActive ? 'status.active' : 'status.revoked')}
                  </span>
                </td>
                <td className="py-3.5 text-right whitespace-nowrap">
                  {!isActive && (
                    <span className="text-xs text-ink-3">{t('revoked')}</span>
                  )}
                  {isActive && isConfirming && (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onConfirmRevoke(key.id)}
                        aria-label={t('confirmLabel', { name: key.name })}
                        className="min-h-[44px] px-3 rounded-sm bg-danger hover:bg-danger/90 text-canvas text-xs font-semibold transition-colors"
                      >
                        {t('confirm')}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRequestRevoke(null)}
                        aria-label={t('cancelLabel', { name: key.name })}
                        className="min-h-[44px] px-3 rounded-sm border border-rule text-xs font-semibold text-ink-2"
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  )}
                  {isActive && !isConfirming && (
                    <button
                      type="button"
                      onClick={() => onRequestRevoke(key.id)}
                      aria-label={t('revokeLabel', { name: key.name })}
                      className="min-w-[44px] min-h-[44px] px-3 rounded-sm border border-rule text-xs text-danger hover:bg-danger-soft font-semibold transition-colors"
                    >
                      {t('revoke')}
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
