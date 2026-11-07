import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { localeAlternates } from './metadata';
import { routing, type AppLocale } from './routing';

export type LocaleParams = Promise<{ locale: string }>;

/** The locale of a page's `[locale]` segment, set for the static render of that page; an unknown locale is a 404. */
export async function resolvePageLocale(params: LocaleParams): Promise<AppLocale> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return locale;
}

/** A page's title and description from `meta.<page>`, with its canonical URL and hreflang alternates. */
export async function localizedPageMetadata(
  params: LocaleParams,
  page: 'home' | 'auth' | 'passwordReset' | 'emailVerification' | 'dashboard' | 'apiDocs',
  pathname: string
): Promise<Metadata> {
  const locale = await resolvePageLocale(params);
  const t = await getTranslations({ locale, namespace: `meta.${page}` });
  return { title: t('title'), description: t('description'), alternates: localeAlternates(locale, pathname) };
}
