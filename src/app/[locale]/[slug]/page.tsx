import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import ConverterPageView from '@/components/pages/ConverterPageView';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import PageMessages from '@/i18n/PageMessages';
import { localeAlternates, socialMetadata } from '@/i18n/metadata';
import { getPathname } from '@/i18n/navigation';
import { resolvePageLocale } from '@/i18n/page';
import type { AppLocale } from '@/i18n/routing';
import { aliasRedirectSlug, parseConverterSlug, type ParsedSlug } from '@/lib/slug-parser';
import { getAnonymousDailyLimit } from '@/lib/plan-limits';

interface ConverterPageProps {
  params: Promise<{ locale: string; slug: string }>;
}

/** The parsed slug of a page of the site; another name of a format is answered 308 to the page of its canonical name, and a path the site offers no page at 404. */
function pageSlug(slug: string, locale: AppLocale): ParsedSlug {
  const parsed = parseConverterSlug(slug);
  if (parsed) return parsed;
  const redirected = aliasRedirectSlug(slug);
  return redirected ? permanentRedirect(getPathname({ locale, href: `/${redirected}` })) : notFound();
}

export async function generateMetadata({ params }: ConverterPageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await resolvePageLocale(params);
  const parsed = pageSlug(slug, locale);
  const [tSlug, tMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'slugPages' }),
    getTranslations({ locale, namespace: 'meta.converter' }),
  ]);
  const copy = localizeSlugCopy(tSlug, parsed, locale);
  const title = tMeta('title', { title: copy.title });
  return {
    title,
    description: copy.description,
    alternates: localeAlternates(locale, parsed.canonicalPath),
    ...socialMetadata(locale, parsed.canonicalPath, title, copy.description),
  };
}

export default async function ConverterPage({ params }: Readonly<ConverterPageProps>) {
  const { slug } = await params;
  const locale = await resolvePageLocale(params);
  const parsed = pageSlug(slug, locale);
  return (
    <PageMessages
      page="converter"
      formatIds={[parsed.sourceFormat, parsed.targetFormat]}
      webAppJsonLd={parsed.isInfoPage ? undefined : { kind: 'converter', locale, parsed }}
    >
      <ConverterPageView parsed={parsed} dailyLimit={getAnonymousDailyLimit()} />
    </PageMessages>
  );
}
