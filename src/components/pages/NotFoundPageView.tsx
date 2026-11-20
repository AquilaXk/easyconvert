'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { usePathname } from '@/i18n/navigation';
import { displayRoute } from '@/lib/display-route';

/** What a path the site offers no page at shows: the header and the footer of every page, then centred a small code, one heading that names the route, and one sentence. */
export default function NotFoundPageView() {
  const t = useTranslations('notFound');
  const route = displayRoute(usePathname());

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main id="main-content" className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-16 text-center">
        <p className="text-sm font-semibold text-ink-3">{t('code')}</p>
        <h1 className="mt-3 max-w-2xl text-2xl sm:text-3xl text-ink break-keep break-words">{t('title', { route })}</h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-ink-2 break-keep">{t('description')}</p>
      </main>

      <Footer />
    </div>
  );
}
