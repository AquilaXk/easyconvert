import React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Check, Clock, Code2, Key, Shield } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useTierLabel } from '../i18n/format';
import type { User } from '@/lib/auth/types';
import type { ApiKey, QuotaUsage } from '@/lib/api-keys/types';
import { TIER_LIMITS } from '@/lib/plan-limits';
import { displayedUsage } from './dashboard-types';

interface AccountQuotaPanelProps {
  user: User;
  quota: QuotaUsage | null;
  apiKeys: ApiKey[];
}

export function AccountQuotaPanel({ user, quota, apiKeys }: Readonly<AccountQuotaPanelProps>) {
  const t = useTranslations('dashboard.usage');
  const format = useFormatter();
  const tierLabel = useTierLabel();
  const activeKeyCount = apiKeys.filter((key) => key.status === 'active').length;
  const dailyLimit = quota?.dailyLimit ?? TIER_LIMITS[user.tier];
  const usedToday = displayedUsage(quota?.usedToday ?? 0, dailyLimit);
  const remaining = quota?.remaining ?? dailyLimit;

  return (
    <div
      id="dashboard-panel-usage"
      role="tabpanel"
      aria-labelledby="dashboard-tab-usage"
      className="space-y-6"
    >
      <div className="border-t border-rule pt-6 sm:pt-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-rule pb-5">
          <div>
            <h2 className="text-xl sm:text-2xl text-ink">
              {t('heading')}
            </h2>
            <p className="text-sm text-ink-2 mt-1">
              {t('intro')}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-bold uppercase tracking-wider bg-accent-soft text-accent-ink border border-accent-edge self-start sm:self-auto">
            <Shield className="w-3.5 h-3.5" />
            {t('tier', { tier: tierLabel(user.tier) })}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-md border border-rule">
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
              {t('quota')}
            </div>
            <div className="mt-1.5 text-2xl font-bold text-ink">
              {format.number(usedToday)} / {format.number(dailyLimit)}
            </div>
            <p className="mt-1 text-xs text-ink-2">
              {t('remaining', { count: remaining })}
            </p>
          </div>

          <div className="p-4 rounded-md border border-rule">
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
              {t('activeKeys')}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-2xl font-bold text-ink">
              <Key className="w-5 h-5 text-accent-ink" />
              <span>{activeKeyCount}</span>
            </div>
            <p className="mt-1 text-xs text-ink-2">
              {t('activeKeysNote')}
            </p>
          </div>

          <div className="p-4 rounded-md border border-rule">
            <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
              {t('reset')}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-2xl font-bold text-ink">
              <Clock className="w-5 h-5 text-accent-ink" />
              <span>00:00 UTC</span>
            </div>
            <p className="mt-1 text-xs text-ink-2">
              {quota?.resetAt
                ? t('nextReset', {
                    date: format.dateTime(new Date(quota.resetAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }),
                  })
                : t('resetDaily')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div className="p-5 rounded-md border border-rule space-y-2.5">
            <h3 className="text-sm font-bold text-ink">
              {t('workbench.heading')}
            </h3>
            <ul className="space-y-2 text-xs sm:text-sm text-ink-2">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-success shrink-0 mt-0.5" />
                <span>{t('workbench.free')}</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-success shrink-0 mt-0.5" />
                <span>{t('workbench.local')}</span>
              </li>
            </ul>
          </div>

          <div className="p-5 rounded-md border border-rule space-y-2.5">
            <h3 className="text-sm font-bold text-ink">
              {t('api.heading')}
            </h3>
            <ul className="space-y-2 text-xs sm:text-sm text-ink-2">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-success shrink-0 mt-0.5" />
                <span>{t.rich('api.scopes', { code: (chunks) => <code>{chunks}</code> })}</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-success shrink-0 mt-0.5" />
                <span>{t('api.isolation')}</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-2 flex flex-wrap items-center gap-3">
          <Link
            href="/api-docs"
            className="btn-primary min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-semibold"
          >
            <Code2 className="w-4 h-4" />
            <span>{t('reference')}</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
