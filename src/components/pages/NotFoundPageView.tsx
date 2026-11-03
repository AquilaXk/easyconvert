import React from 'react';
import { useTranslations } from 'next-intl';
import Header from '@/components/Header';

/** What a path the site offers no page at shows: the header, and the code with a sentence saying so, centred. */
export default function NotFoundPageView() {
  const t = useTranslations('notFound');

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main id="main-content" className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 text-center">
        <p className="text-sm font-semibold text-danger">{t('code')}</p>
        <h1 className="mt-3 max-w-3xl text-3xl sm:text-5xl text-ink">{t('title')}</h1>
        <p className="mt-4 max-w-xl text-sm sm:text-base text-ink-2">{t('description')}</p>
      </main>
    </div>
  );
}
