import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import ConverterPageView from '@/components/pages/ConverterPageView';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import PageMessages from '@/i18n/PageMessages';
import { localeAlternates } from '@/i18n/metadata';
import { resolvePageLocale } from '@/i18n/page';
import { canonicalSlugPath, isFileSlug, isIndexableSlug, parseConverterSlug, type ParsedSlug } from '@/lib/slug-parser';

interface ConverterPageProps {
  params: Promise<{ locale: string; slug: string }>;
}

/** The parsed slug of a converter page; a slug that names a file is answered 404. */
function pageSlug(slug: string): ParsedSlug {
  if (isFileSlug(slug)) notFound();
  return parseConverterSlug(slug);
}

export async function generateMetadata({ params }: ConverterPageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await resolvePageLocale(params);
  const [tSlug, tMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'slugPages' }),
    getTranslations({ locale, namespace: 'meta.converter' }),
  ]);
  const parsed = pageSlug(slug);
  const copy = localizeSlugCopy(tSlug, parsed.copy);
  return {
    title: tMeta('title', { title: copy.title }),
    description: copy.description,
    alternates: localeAlternates(locale, canonicalSlugPath(slug)),
    ...(isIndexableSlug(parsed) ? {} : { robots: { index: false } }),
  };
}

export default async function ConverterPage({ params }: Readonly<ConverterPageProps>) {
  const { slug } = await params;
  await resolvePageLocale(params);
  const parsed = pageSlug(slug);

  return (
    <PageMessages page="converter" formatIds={[parsed.sourceFormat, parsed.targetFormat]}>
      <ConverterPageView slug={slug} />
    </PageMessages>
  );
}
