import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import type { ParsedSlug } from '@/lib/slug-parser';
import { AboutContent, ContactContent, PolicySections } from './info-page-sections';

const ROOT_SHELL_CLASS =
  'flex flex-col min-h-screen';

interface ConverterInfoPageProps {
  parsed: ParsedSlug;
  /** The page's title and description in the visitor's language. */
  copy: { title: string; description: string };
  totalFormatCount: number;
  /** The anonymous daily allowance the server enforces. */
  dailyLimit: number;
}

export function ConverterInfoPage({ parsed, copy, totalFormatCount, dailyLimit }: Readonly<ConverterInfoPageProps>) {
  return (
    <div className={ROOT_SHELL_CLASS}>
      <Header />
      <main
        id="main-content"
        className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12"
      >
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl text-ink">
            {copy.title}
          </h1>
          <p className="mt-3 text-base sm:text-lg text-ink-3">
            {copy.description}
          </p>
        </div>

        <div className="border-t border-rule pt-6 sm:pt-8 text-sm text-ink-2 leading-relaxed">
          {parsed.infoType === 'contact' && <ContactContent />}
          {parsed.infoType === 'about' && <AboutContent totalFormatCount={totalFormatCount} dailyLimit={dailyLimit} />}
          {parsed.infoType !== 'contact' && parsed.infoType !== 'about' && (
            <div className="max-w-3xl space-y-6">
              <PolicySections infoType={parsed.infoType} totalFormatCount={totalFormatCount} dailyLimit={dailyLimit} />
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
