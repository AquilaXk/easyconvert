'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useViewerAccount } from '@/hooks/useViewerPlan';
import type { SessionUser } from '@/lib/viewer-plan';
import { useTierLabel } from './i18n/format';

interface UserNavProps {
  mobile?: boolean;
  onItemClick?: () => void;
  initialUser?: SessionUser;
}

export default function UserNav({ mobile = false, onItemClick, initialUser }: Readonly<UserNavProps>) {
  const t = useTranslations('userNav');
  const tierLabel = useTierLabel();
  const user = useViewerAccount(initialUser);

  if (mobile) {
    if (user) {
      return (
        <div className="flex items-center justify-between gap-3 py-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full bg-accent text-on-accent flex items-center justify-center text-xs font-bold shrink-0">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <span className="text-sm font-semibold text-ink truncate">{user.name}</span>
            <span className="text-[11px] uppercase font-semibold px-1.5 py-0.5 rounded-xs bg-accent-soft text-accent-ink shrink-0">
              {tierLabel(user.tier)}
            </span>
          </div>
          <Link
            href="/dashboard"
            onClick={onItemClick}
            className="min-h-[44px] px-3 inline-flex items-center text-sm text-accent-ink font-semibold rounded-sm hover:bg-accent-soft"
          >
            {t('dashboard')}
          </Link>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-2 gap-2.5">
        <Link
          href="/auth"
          onClick={onItemClick}
          className="min-h-[44px] inline-flex items-center justify-center px-3 text-sm font-semibold rounded-sm border border-rule text-ink hover:bg-sunken transition-colors"
        >
          {t('logIn')}
        </Link>
        <Link
          href={{ pathname: '/auth', query: { tab: 'register' } }}
          onClick={onItemClick}
          className="min-h-[44px] inline-flex items-center justify-center px-3 text-sm font-medium rounded-xs bg-ink text-canvas hover:bg-ink/90 transition-colors"
        >
          {t('signUp')}
        </Link>
      </div>
    );
  }

  if (user) {
    return (
      <Link
        href="/dashboard"
        className="min-h-[44px] inline-flex items-center gap-2 px-3 rounded-sm border border-rule hover:border-rule-strong transition-colors text-xs font-semibold text-ink"
      >
        <div className="w-5 h-5 rounded-full bg-accent text-on-accent flex items-center justify-center text-[10px] font-bold shrink-0">
          {user.name.charAt(0).toUpperCase()}
        </div>
        <span>{user.name.split(' ')[0]}</span>
        <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded-xs bg-sunken text-ink-2">
          {tierLabel(user.tier)}
        </span>
      </Link>
    );
  }

  return (
    <>
      <Link
        href="/auth"
        className="px-2.5 py-1.5 inline-flex items-center text-sm font-medium text-ink hover:bg-sunken/50 rounded-xs transition-colors"
      >
        {t('logIn')}
      </Link>
      <Link
        href={{ pathname: '/auth', query: { tab: 'register' } }}
        className="px-2.5 py-1.5 inline-flex items-center text-sm font-medium rounded-xs bg-ink text-canvas hover:bg-ink/90 transition-colors"
      >
        {t('signUp')}
      </Link>
    </>
  );
}
