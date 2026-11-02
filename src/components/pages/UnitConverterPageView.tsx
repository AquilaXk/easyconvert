import React from 'react';
import { useTranslations } from 'next-intl';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import UnitConverter from '@/components/UnitConverter';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';

/** The unit converter page; `dailyLimit` is the anonymous daily allowance the server enforces, read on the server. */
export default function UnitConverterPageView({ dailyLimit }: Readonly<{ dailyLimit: number }>) {
  const t = useTranslations('unitConverterPage');

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main id="main-content" className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <div className="mb-8">
          <h1 className="text-3xl sm:text-5xl text-ink">
            {t('heading')}
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-2 max-w-3xl">
            {t('intro')}
          </p>
        </div>

        <UnitConverter />

        <AdBanner slot="mid-content" className="mt-12" />

        <div className="mt-12">
          <FaqSection dailyLimit={dailyLimit} />
        </div>
      </main>

      <Footer />
    </div>
  );
}
