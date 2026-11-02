'use client';

import React, { Suspense } from 'react';
import NextLink from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { getPathname, usePathname } from '@/i18n/navigation';
import { LOCALE_COOKIE, routing, type AppLocale } from '@/i18n/routing';

/** Each language is named in itself, so a reader finds theirs whatever the page's language is. */
const LANGUAGE_NAMES: Readonly<Record<AppLocale, string>> = {
  en: 'English',
  ko: '한국어',
};

/** Remembers the chosen language, so the root opens in it next time. */
function rememberLocale(locale: AppLocale): void {
  document.cookie = `${LOCALE_COOKIE.name}=${locale}; path=/; samesite=${LOCALE_COOKIE.sameSite}`;
}

function LanguageLinks({ query }: Readonly<{ query: string }>) {
  const locale = useLocale();
  const pathname = usePathname() ?? '/';
  const hrefIn = (target: AppLocale) => {
    const localized = getPathname({ href: pathname, locale: target });
    return query ? `${localized}?${query}` : localized;
  };

  return (
    <ul className="flex items-center">
      {routing.locales.map((target) => {
        const isCurrent = target === locale;
        return (
          <li key={target} className="flex items-center">
            <NextLink
              href={hrefIn(target)}
              hrefLang={target}
              prefetch={isCurrent ? undefined : false}
              onClick={isCurrent ? undefined : () => rememberLocale(target)}
              lang={target}
              aria-current={isCurrent ? 'true' : undefined}
              className={`min-h-[44px] px-2.5 inline-flex items-center rounded-sm text-sm transition-colors ${
                isCurrent ? 'font-semibold text-ink' : 'font-medium text-ink-2 hover:text-ink'
              }`}
            >
              {LANGUAGE_NAMES[target]}
            </NextLink>
          </li>
        );
      })}
    </ul>
  );
}

function LanguageLinksWithQuery() {
  return <LanguageLinks query={useSearchParams()?.toString() ?? ''} />;
}

/**
 * Links to the current page, query included, in every language, at the URL that language has (English unprefixed, so no
 * link answers with a redirect). A link to another language writes the locale cookie when followed, so the root opens in
 * the chosen language next time. The query is known only in the browser, so a
 * prerendered page links the path alone until it loads (the Suspense boundary keeps the page static).
 */
export default function LanguageSwitcher({ className = '' }: Readonly<{ className?: string }>) {
  const t = useTranslations('languageSwitcher');
  return (
    <nav aria-label={t('label')} className={className}>
      <Suspense fallback={<LanguageLinks query="" />}>
        <LanguageLinksWithQuery />
      </Suspense>
    </nav>
  );
}
