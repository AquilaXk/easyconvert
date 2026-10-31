import React from 'react';
import Link from 'next/link';
import { Check, Clock, Code2, Key, Shield } from 'lucide-react';
import type { User } from '@/lib/auth/types';
import type { ApiKey, QuotaUsage } from '@/lib/api-keys/types';

interface AccountQuotaPanelProps {
  user: User;
  quota: QuotaUsage | null;
  apiKeys: ApiKey[];
}

export function AccountQuotaPanel({ user, quota, apiKeys }: Readonly<AccountQuotaPanelProps>) {
  const activeKeyCount = apiKeys.filter((key) => key.status === 'active').length;
  const dailyLimit = quota?.dailyLimit ?? 25;
  const usedToday = quota?.usedToday ?? 0;
  const remaining = quota?.remaining ?? dailyLimit;

  return (
    <div
      id="dashboard-panel-usage"
      role="tabpanel"
      aria-labelledby="dashboard-tab-usage"
      className="space-y-6"
    >
      <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 sm:p-8 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-border dark:border-dark-border pb-5">
          <div>
            <h2 className="text-lg sm:text-xl font-bold text-brand-950 dark:text-white">
              Usage &amp; Rate Limits
            </h2>
            <p className="text-sm text-ink-secondary dark:text-dark-muted mt-1">
              Live account tier telemetry, programmatic API rate allocations, and retention rules.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider bg-brand-50 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-white/15 self-start sm:self-auto">
            <Shield className="w-3.5 h-3.5" />
            Active Tier: {user.tier.toUpperCase()}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border">
            <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
              Daily API Quota
            </div>
            <div className="mt-1.5 text-2xl font-bold text-brand-950 dark:text-white">
              {usedToday} / {dailyLimit}
            </div>
            <p className="mt-1 text-xs text-ink-secondary dark:text-dark-muted">
              {remaining} programmatic requests remaining today
            </p>
          </div>

          <div className="p-4 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border">
            <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
              Active API Keys
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-2xl font-bold text-brand-950 dark:text-white">
              <Key className="w-5 h-5 text-brand-700 dark:text-brand-400" />
              <span>{activeKeyCount}</span>
            </div>
            <p className="mt-1 text-xs text-ink-secondary dark:text-dark-muted">
              Scoped RBAC credentials enabled on this account
            </p>
          </div>

          <div className="p-4 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border">
            <div className="text-xs font-semibold text-ink-muted dark:text-dark-muted uppercase tracking-wider">
              Quota Window Reset
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-2xl font-bold text-brand-950 dark:text-white">
              <Clock className="w-5 h-5 text-brand-700 dark:text-brand-400" />
              <span>00:00 UTC</span>
            </div>
            <p className="mt-1 text-xs text-ink-secondary dark:text-dark-muted">
              {quota?.resetAt
                ? `Next reset at ${new Date(quota.resetAt).toUTCString()}`
                : 'Counters reset daily at midnight UTC'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div className="p-5 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border space-y-2.5">
            <h3 className="text-sm font-bold text-brand-950 dark:text-white">
              Interactive Web Workbench
            </h3>
            <ul className="space-y-2 text-xs sm:text-sm text-ink-secondary dark:text-dark-muted">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-status-success dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>Free interactive browser conversions without daily paywalls or watermarks</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-status-success dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>Local WebAssembly execution for supported client-side formats</span>
              </li>
            </ul>
          </div>

          <div className="p-5 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border space-y-2.5">
            <h3 className="text-sm font-bold text-brand-950 dark:text-white">
              Programmatic REST API Policy
            </h3>
            <ul className="space-y-2 text-xs sm:text-sm text-ink-secondary dark:text-dark-muted">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-status-success dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>Per-key RBAC scopes (<code>convert:write</code>, <code>convert:read</code>, <code>storage:download</code>)</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-status-success dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>Isolated worker execution with automatic short-TTL artifact deletion</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-2 flex flex-wrap items-center gap-3">
          <Link
            href="/api-docs"
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold shadow-sm transition-colors"
          >
            <Code2 className="w-4 h-4" />
            <span>View OpenAPI Reference</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
