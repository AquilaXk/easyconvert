import React from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import PageMessages from '@/i18n/PageMessages';
import { localeAlternates } from '@/i18n/metadata';
import { resolvePageLocale, type LocaleParams } from '@/i18n/page';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from '@/lib/legal/documents';
import { readLegalPage } from '@/lib/legal/render';
import { LEGAL_TEXTS } from '@/lib/legal/texts';
import { LegalDocument } from './LegalDocument';

/** A legal page's title and description, both read from its Markdown, with its canonical URL and hreflang alternates. */
export async function legalPageMetadata(params: LocaleParams, id: LegalDocumentId): Promise<Metadata> {
  const locale = await resolvePageLocale(params);
  const t = await getTranslations({ locale, namespace: 'meta.legal' });
  const { title, summary } = readLegalPage(LEGAL_TEXTS[id][locale]);
  return { title: t('title', { title }), description: summary, alternates: localeAlternates(locale, LEGAL_DOCUMENTS[id].path) };
}

export default async function LegalDocumentPage({ params, id }: Readonly<{ params: LocaleParams; id: LegalDocumentId }>) {
  const locale = await resolvePageLocale(params);
  return (
    <PageMessages page="legal">
      <div className="flex flex-col min-h-screen">
        <Header />
        <main id="main-content" className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <LegalDocument id={id} locale={locale} />
        </main>
        <Footer />
      </div>
    </PageMessages>
  );
}
