import React from 'react';
import Image from 'next/image';
import { FileText, Key, Layers, LogOut, Send, Shield } from 'lucide-react';
import type { User } from '@/lib/auth/types';
import type { DashboardTab } from './dashboard-types';

interface DashboardHeaderProps {
  user: User;
  activeTab: DashboardTab;
  filesCount: number;
  dlqCount: number;
  onSelectTab: (tab: DashboardTab) => void;
  onLogout: () => void;
}

export function DashboardHeader({
  user,
  activeTab,
  filesCount,
  dlqCount,
  onSelectTab,
  onLogout,
}: Readonly<DashboardHeaderProps>) {
  const tabs: Array<{
    id: DashboardTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
    badgeDanger?: boolean;
  }> = [
    { id: 'api', label: 'Developer API Keys', icon: Key },
    { id: 'files', label: 'My Converted Files', icon: FileText, badge: filesCount },
    { id: 'dlq', label: 'Webhook DLQ', icon: Send, badge: dlqCount, badgeDanger: true },
    { id: 'usage', label: 'Usage & Rate Limits', icon: Layers },
  ];

  return (
    <>
      <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 shadow-sm mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-14 h-14 rounded-lg bg-brand-700 text-white flex items-center justify-center text-xl font-bold shrink-0 overflow-hidden">
            {user.avatarUrl ? (
              <Image
                src={user.avatarUrl}
                alt={user.name}
                width={56}
                height={56}
                unoptimized
                className="w-full h-full object-cover"
              />
            ) : (
              <span>{user.name.charAt(0).toUpperCase()}</span>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-brand-950 dark:text-white">
                Developer Dashboard
              </h1>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-bold uppercase tracking-wider bg-brand-50 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-white/15">
                <Shield className="w-3.5 h-3.5" aria-hidden="true" />
                {user.tier.toUpperCase()} TIER
              </span>
            </div>
            <p className="text-sm text-ink-secondary dark:text-dark-muted mt-1 break-all">
              {user.name} ({user.email})
            </p>
            <div className="flex flex-wrap items-center gap-2.5 text-xs text-ink-muted dark:text-dark-muted mt-1.5">
              <span>
                Auth provider <strong className="capitalize">{user.provider}</strong>
              </span>
              <span aria-hidden="true">&bull;</span>
              <span>Member since {new Date(user.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-neutral-300 hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-dark-elevated text-sm font-semibold transition-colors"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Dashboard sections"
        className="flex border-b border-neutral-border dark:border-dark-border mb-8 overflow-x-auto gap-1"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`dashboard-tab-${tab.id}`}
              role="tab"
              aria-selected={isSelected}
              aria-controls={`dashboard-panel-${tab.id}`}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              className={`min-h-[44px] flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                isSelected
                  ? 'border-brand-700 text-brand-700 dark:text-brand-400 dark:border-brand-400'
                  : 'border-transparent text-ink-secondary dark:text-dark-muted hover:text-brand-950 dark:hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge > 0 && (
                <span
                  className={
                    tab.badgeDanger
                      ? 'ml-1 px-2 py-0.5 text-xs rounded-md bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 font-bold border border-rose-300 dark:border-rose-800'
                      : 'ml-1 px-2 py-0.5 text-xs rounded-md bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300 font-semibold'
                  }
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
