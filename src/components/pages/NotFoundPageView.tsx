'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import BrandLogo from '@/components/BrandLogo';
import { Link, usePathname } from '@/i18n/navigation';
import { useThemeToggle } from '@/hooks/useThemeToggle';

/** What a path the site offers no page at shows: a thin header with the logo, then centred a small code, one heading that names the route, and one sentence. */
export default function NotFoundPageView() {
  const t = useTranslations('notFound');
  const tHeader = useTranslations('header');
  const route = usePathname().slice(1);
  // The framework's error shell renders this document, so the theme script of the layout has not run; the hook applies the stored theme.
  useThemeToggle();

  return (
    <div className="flex flex-col min-h-screen">
      <header className="bg-surface text-ink border-b border-rule h-[var(--header-height)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center">
          <Link href="/" aria-label={tHeader('homeLabel')} className="min-h-[44px] inline-flex items-center rounded-sm">
            <BrandLogo size="md" />
          </Link>
        </div>
      </header>

      <main id="main-content" className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 text-center">
        <p className="text-sm font-semibold text-danger">{t('code')}</p>
        <h1 className="mt-3 max-w-3xl text-3xl sm:text-5xl text-ink break-words">{t('title', { route })}</h1>
        <p className="mt-4 max-w-xl text-sm sm:text-base text-ink-2">{t('description')}</p>
      </main>
    </div>
  );
}
