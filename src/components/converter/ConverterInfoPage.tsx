import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';
import StatusDashboard from '@/components/StatusDashboard';
import UnitConverter from '@/components/UnitConverter';
import type { ParsedSlug } from '@/lib/slug-parser';
import { ContactContent, getPolicySections } from './info-page-sections';

const ROOT_SHELL_CLASS =
  'flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors';

interface ConverterInfoPageProps {
  parsed: ParsedSlug;
  totalFormatCount: number;
}

export function ConverterInfoPage({ parsed, totalFormatCount }: Readonly<ConverterInfoPageProps>) {
  if (parsed.infoType === 'status') {
    return (
      <div className={ROOT_SHELL_CLASS}>
        <Header />
        <main
          id="main-content"
          className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12"
        >
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-brand-950 dark:text-white">
              {parsed.pageTitle}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-3xl">
              {parsed.pageDescription}
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
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-brand-950 dark:text-white">
              {parsed.pageTitle}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-2xl">
              {parsed.pageDescription}
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

  const sections = getPolicySections(parsed.infoType, totalFormatCount);

  return (
    <div className={ROOT_SHELL_CLASS}>
      <Header />
      <main
        id="main-content"
        className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14"
      >
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-brand-950 dark:text-white tracking-tight">
            {parsed.pageTitle}
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400">
            {parsed.pageDescription}
          </p>
        </div>

        <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 sm:p-8 shadow-sm space-y-6 text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
          {parsed.infoType === 'contact' ? (
            <ContactContent />
          ) : (
            sections.map((section) => (
              <section key={section.heading} className="space-y-2">
                <h2 className="text-lg font-bold text-brand-950 dark:text-white">
                  {section.heading}
                </h2>
                <p>{section.body}</p>
                {section.footer}
              </section>
            ))
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
