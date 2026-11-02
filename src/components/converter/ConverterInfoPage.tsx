import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';
import StatusDashboard from '@/components/StatusDashboard';
import UnitConverter from '@/components/UnitConverter';
import type { ParsedSlug } from '@/lib/slug-parser';
import { ContactContent, PolicySections } from './info-page-sections';

const ROOT_SHELL_CLASS =
  'flex flex-col min-h-screen';

interface ConverterInfoPageProps {
  parsed: ParsedSlug;
  /** The page's title and description in the visitor's language. */
  copy: { title: string; description: string };
  totalFormatCount: number;
}

export function ConverterInfoPage({ parsed, copy, totalFormatCount }: Readonly<ConverterInfoPageProps>) {
  if (parsed.infoType === 'status') {
    return (
      <div className={ROOT_SHELL_CLASS}>
        <Header />
        <main
          id="main-content"
          className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12"
        >
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl text-ink">
              {copy.title}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-ink-2 max-w-3xl">
              {copy.description}
            </p>
          </div>
          <StatusDashboard />
        </main>
        <Footer />
      </div>
    );
  }

  if (parsed.infoType === 'unit') {
    return (
      <div className={ROOT_SHELL_CLASS}>
        <Header />
        <main
          id="main-content"
          className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12"
        >
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl text-ink">
              {copy.title}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-ink-2 max-w-2xl">
              {copy.description}
            </p>
          </div>
          <UnitConverter initialSrc={parsed.sourceFormat} initialTgt={parsed.targetFormat} />
          <div className="mt-12">
            <AdBanner slot="mid-content" />
          </div>
          <div className="mt-10">
            <FaqSection />
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className={ROOT_SHELL_CLASS}>
      <Header />
      <main
        id="main-content"
        className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14"
      >
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl text-ink">
            {copy.title}
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-2">
            {copy.description}
          </p>
        </div>

        <div className="border-t border-rule pt-6 sm:pt-8 space-y-6 text-sm text-ink-2 leading-relaxed">
          {parsed.infoType === 'contact' ? (
            <ContactContent />
          ) : (
            <PolicySections infoType={parsed.infoType} totalFormatCount={totalFormatCount} />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
