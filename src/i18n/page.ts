import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { localeAlternates, socialMetadata } from './metadata';
import { routing, type AppLocale } from './routing';

export type LocaleParams = Promise<{ locale: string }>;

const PRIVATE_PAGES = new Set(['auth', 'passwordReset', 'emailVerification', 'dashboard']);

/** The locale of a page's `[locale]` segment, set for the static render of that page; an unknown locale is a 404. */
export async function resolvePageLocale(params: LocaleParams): Promise<AppLocale> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return locale;
}

/** A page's title and description from `meta.<page>`, with its canonical URL, hreflang alternates, and public social cards. */
export async function localizedPageMetadata(
  params: LocaleParams,
  page: 'home' | 'auth' | 'passwordReset' | 'emailVerification' | 'dashboard' | 'apiDocs' | 'pricing',
  pathname: string
): Promise<Metadata> {
  const locale = await resolvePageLocale(params);
  const t = await getTranslations({ locale, namespace: `meta.${page}` });
  const title = t('title');
  const description = t('description');
  return {
    title,
    description,
    alternates: localeAlternates(locale, pathname),
    ...(PRIVATE_PAGES.has(page) ? {} : socialMetadata(locale, pathname, title, description)),
  };
}
