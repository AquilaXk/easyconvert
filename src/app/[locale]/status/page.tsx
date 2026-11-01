import React from 'react';
import { getTranslations } from 'next-intl/server';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import StatusDashboard from '@/components/StatusDashboard';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'status', '/status');
}

export default async function StatusPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  const t = await getTranslations('statusPage');

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main id="main-content" className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl text-ink">
            {t('heading')}
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-2 max-w-3xl">
            {t('intro')}
          </p>
        </div>

        <StatusDashboard />
      </main>

      <Footer />
    </div>
  );
}
