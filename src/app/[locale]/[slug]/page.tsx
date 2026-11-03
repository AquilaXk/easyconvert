import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import ConverterPageView from '@/components/pages/ConverterPageView';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import PageMessages from '@/i18n/PageMessages';
import { localeAlternates } from '@/i18n/metadata';
import { resolvePageLocale } from '@/i18n/page';
import { parseConverterSlug, type ParsedSlug } from '@/lib/slug-parser';
import { getAnonymousDailyLimit } from '@/lib/plan-limits';

interface ConverterPageProps {
  params: Promise<{ locale: string; slug: string }>;
}

/** The parsed slug of a page of the site; a path the site offers no page at is answered 404. */
function pageSlug(slug: string): ParsedSlug {
  return parseConverterSlug(slug) ?? notFound();
}

export async function generateMetadata({ params }: ConverterPageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await resolvePageLocale(params);
  const parsed = pageSlug(slug);
  const [tSlug, tMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'slugPages' }),
    getTranslations({ locale, namespace: 'meta.converter' }),
  ]);
  const copy = localizeSlugCopy(tSlug, parsed, locale);
  return {
    title: tMeta('title', { title: copy.title }),
    description: copy.description,
    alternates: localeAlternates(locale, parsed.canonicalPath),
  };
}

export default async function ConverterPage({ params }: Readonly<ConverterPageProps>) {
  const { slug } = await params;
  await resolvePageLocale(params);
  const parsed = pageSlug(slug);

  return (
    <PageMessages page="converter" formatIds={[parsed.sourceFormat, parsed.targetFormat]}>
      <ConverterPageView parsed={parsed} dailyLimit={getAnonymousDailyLimit()} />
    </PageMessages>
  );
}
