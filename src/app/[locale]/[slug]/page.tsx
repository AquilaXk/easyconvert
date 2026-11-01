import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import ConverterPageView from '@/components/pages/ConverterPageView';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import PageMessages from '@/i18n/PageMessages';
import { localeAlternates } from '@/i18n/metadata';
import { resolvePageLocale } from '@/i18n/page';
import { parseConverterSlug } from '@/lib/slug-parser';

interface ConverterPageProps {
  params: Promise<{ locale: string; slug: string }>;
}

export async function generateMetadata({ params }: ConverterPageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await resolvePageLocale(params);
  const [tSlug, tMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'slugPages' }),
    getTranslations({ locale, namespace: 'meta.converter' }),
  ]);
  const copy = localizeSlugCopy(tSlug, parseConverterSlug(slug).copy);
  return {
    title: tMeta('title', { title: copy.title }),
    description: copy.description,
    alternates: localeAlternates(locale, `/${slug}`),
  };
}

export default async function ConverterPage({ params }: Readonly<ConverterPageProps>) {
  const { slug } = await params;
  await resolvePageLocale(params);
  const parsed = parseConverterSlug(slug);

  return (
    <PageMessages page="converter" formatIds={[parsed.sourceFormat, parsed.targetFormat]}>
      <ConverterPageView slug={slug} />
    </PageMessages>
  );
}
