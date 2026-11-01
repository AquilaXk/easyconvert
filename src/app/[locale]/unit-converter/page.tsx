import React from 'react';
import { getTranslations } from 'next-intl/server';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import UnitConverter from '@/components/UnitConverter';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';
import { localizedPageMetadata, resolvePageLocale, type LocaleParams } from '@/i18n/page';

export function generateMetadata({ params }: { params: LocaleParams }) {
  return localizedPageMetadata(params, 'unitConverter', '/unit-converter');
}

export default async function UnitConverterPage({ params }: Readonly<{ params: LocaleParams }>) {
  await resolvePageLocale(params);
  const t = await getTranslations('unitConverterPage');

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

        <div className="mt-12 min-h-[50px] sm:min-h-[64px] flex items-center justify-center">
          <AdBanner slot="mid-content" />
        </div>

        <div className="mt-12">
          <FaqSection />
        </div>
      </main>

      <Footer />
    </div>
  );
}
