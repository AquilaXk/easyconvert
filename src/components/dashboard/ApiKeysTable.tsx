import React from 'react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { Key, Trash2 } from 'lucide-react';
import type { ApiKey } from '@/lib/api-keys/types';

const DATE_FORMAT = { dateStyle: 'medium' } as const;

function KeyExpirationBadge({ expiresAt }: Readonly<{ expiresAt?: number }>) {
  const t = useTranslations('dashboard.keys.table');
  const format = useFormatter();
  const now = useNow().getTime();
  if (!expiresAt) {
    return <span className="text-ink-3">{t('noExpiry')}</span>;
  }
  if (now > expiresAt) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-danger-soft text-danger border border-danger-edge">
        {t('expired')}
      </span>
    );
  }
  const msRemaining = expiresAt - now;
  const sevenDaysMs = 7 * 86400 * 1000;
  if (msRemaining <= sevenDaysMs) {
    const daysRemaining = Math.max(1, Math.ceil(msRemaining / (86400 * 1000)));
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-warning-soft text-warning border border-warning-edge">
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
  onRequestDelete,
}: Readonly<{
  apiKeys: ApiKey[];
  onRequestDelete: (id: string) => void;
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
          <tr className="border-b border-rule text-ink-3 text-xs">
            <th scope="col" className="pb-3 pr-4 font-medium">
              {t('columns.name')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-medium">
              {t('columns.prefix')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-medium">
              {t('columns.created')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-medium">
              {t('columns.expires')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-medium">
              {t('columns.lastUsed')}
            </th>
            <th scope="col" className="pb-3 pr-4 font-medium">
              {t('columns.status')}
            </th>
            <th scope="col" className="pb-3 font-medium text-right">
              {t('columns.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {apiKeys.map((key) => {
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
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-sm text-xs font-semibold border bg-success-soft text-success border-success-edge">
                    {t('status.active')}
                  </span>
                </td>
                <td className="py-3.5 text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onRequestDelete(key.id)}
                    aria-label={t('deleteLabel', { name: key.name })}
                    className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm border border-rule text-ink-3 hover:text-danger hover:bg-danger-soft transition-colors"
                  >
                    <Trash2 aria-hidden="true" className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
