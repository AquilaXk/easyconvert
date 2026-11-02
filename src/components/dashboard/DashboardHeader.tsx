import React, { useRef } from 'react';
import Image from 'next/image';
import { useFormatter, useTranslations } from 'next-intl';
import { FileText, Key, Layers, LogOut, Send, Shield } from 'lucide-react';
import type { User } from '@/lib/auth/types';
import type { DashboardTab } from './dashboard-types';
import { useTierLabel } from '../i18n/format';

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
  const t = useTranslations('dashboard.header');
  const format = useFormatter();
  const tierLabel = useTierLabel();
  const tabRefs = useRef<Record<DashboardTab, HTMLButtonElement | null>>({
    api: null,
    files: null,
    dlq: null,
    usage: null,
  });

  const tabs: Array<{
    id: DashboardTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
    badgeDanger?: boolean;
  }> = [
    { id: 'api', label: t('tabs.api'), icon: Key },
    { id: 'files', label: t('tabs.files'), icon: FileText, badge: filesCount },
    { id: 'dlq', label: t('tabs.dlq'), icon: Send, badge: dlqCount, badgeDanger: true },
    { id: 'usage', label: t('tabs.usage'), icon: Layers },
  ];

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentTab: DashboardTab
  ) => {
    const currentIndex = tabs.findIndex((item) => item.id === currentTab);
    if (currentIndex === -1) return;

    let nextTab: DashboardTab | null = null;
    if (event.key === 'ArrowRight') {
      nextTab = tabs[(currentIndex + 1) % tabs.length].id;
    } else if (event.key === 'ArrowLeft') {
      nextTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length].id;
    } else if (event.key === 'Home') {
      nextTab = tabs[0].id;
    } else if (event.key === 'End') {
      nextTab = tabs.at(-1)?.id ?? null;
    }

    if (nextTab) {
      event.preventDefault();
      onSelectTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  };

  return (
    <>
      <div className="border-t border-rule pt-6 mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-14 h-14 rounded-md bg-accent text-on-accent flex items-center justify-center text-xl font-bold shrink-0 overflow-hidden">
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
              <h1 className="text-2xl sm:text-3xl text-ink">
                {t('heading')}
              </h1>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-sm text-xs font-bold uppercase tracking-wider bg-accent-soft text-accent-ink border border-accent-edge">
                <Shield className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('tier', { tier: tierLabel(user.tier) })}</span>
              </span>
            </div>
            <p className="text-sm text-ink-2 mt-1 break-all">
              {user.name} ({user.email})
            </p>
            <div className="flex flex-wrap items-center gap-2.5 text-xs text-ink-3 mt-1.5">
              <span>
                {t.rich('provider', {
                  provider: t(`providers.${user.provider}`),
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </span>
              <span aria-hidden="true">&bull;</span>
              <span>{t('memberSince', { date: format.dateTime(new Date(user.createdAt), { dateStyle: 'medium' }) })}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-sm border border-rule text-ink-2 hover:text-ink hover:bg-sunken text-sm font-semibold transition-colors"
        >
          <LogOut className="w-4 h-4" />
          <span>{t('signOut')}</span>
        </button>
      </div>

      <div
        role="tablist"
        aria-label={t('sectionsLabel')}
        className="flex border-b border-rule mb-8 overflow-x-auto gap-1"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              id={`dashboard-tab-${tab.id}`}
              role="tab"
              aria-selected={isSelected}
              aria-controls={`dashboard-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
              className={`min-h-[44px] flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                isSelected
                  ? 'border-accent text-accent-ink'
                  : 'border-transparent text-ink-2 hover:text-ink'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge > 0 && (
                <span
                  className={
                    tab.badgeDanger
                      ? 'ml-1 px-2 py-0.5 text-xs rounded-sm bg-danger-soft text-danger font-bold border border-danger-edge'
                      : 'ml-1 px-2 py-0.5 text-xs rounded-sm bg-accent-soft text-accent-ink font-semibold'
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
