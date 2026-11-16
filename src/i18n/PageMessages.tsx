import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import type { ParsedSlug } from '@/lib/slug-parser';
import { clientMessages, type ClientMessagesPage } from './client-messages';
import { webApplicationJsonLd } from './metadata';
import type { AppLocale } from './routing';
import ViewerTimeZone from './ViewerTimeZone';

export type PageWebAppJsonLd =
  | { kind: 'home'; locale: AppLocale }
  | { kind: 'converter'; locale: AppLocale; parsed: ParsedSlug };

async function buildWebAppJsonLd(spec: PageWebAppJsonLd): Promise<string> {
  if (spec.kind === 'home') {
    const t = await getTranslations({ locale: spec.locale, namespace: 'meta.home' });
    return webApplicationJsonLd({
      locale: spec.locale,
      pathname: '/',
      name: t('title'),
      description: t('description'),
    });
  }
  const [tSlug, tMeta] = await Promise.all([
    getTranslations({ locale: spec.locale, namespace: 'slugPages' }),
    getTranslations({ locale: spec.locale, namespace: 'meta.converter' }),
  ]);
  const copy = localizeSlugCopy(tSlug, spec.parsed, spec.locale);
  return webApplicationJsonLd({
    locale: spec.locale,
    pathname: spec.parsed.canonicalPath,
    name: tMeta('title', { title: copy.title }),
    description: copy.description,
  });
}

/** Hands a page's client components the messages that page reads (`PAGE_NAMESPACES`), the viewer's time zone, and optional Schema.org JSON-LD. */
export default async function PageMessages({
  page,
  formatIds,
  webAppJsonLd,
  children,
}: Readonly<{
  page: ClientMessagesPage;
  formatIds?: readonly string[];
  webAppJsonLd?: PageWebAppJsonLd;
  children: ReactNode;
}>) {
  const [messages, jsonLd] = await Promise.all([
    getMessages(),
    webAppJsonLd ? buildWebAppJsonLd(webAppJsonLd) : Promise.resolve(null),
  ]);
  return (
    <>
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />}
      <NextIntlClientProvider messages={clientMessages(messages, page, formatIds)}>
        <ViewerTimeZone>{children}</ViewerTimeZone>
      </NextIntlClientProvider>
    </>
  );
}
