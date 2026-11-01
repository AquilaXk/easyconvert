'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { routing, type AppLocale } from '@/i18n/routing';

/** Each language is named in itself, so a reader finds theirs whatever the page's language is. */
const LANGUAGE_NAMES: Readonly<Record<AppLocale, string>> = {
  en: 'English',
  ko: '한국어',
};

/**
 * Links to the current page in every language. A link to another language writes the locale cookie (next-intl's `Link`),
 * so the root opens in the chosen language next time.
 */
export default function LanguageSwitcher({ className = '' }: Readonly<{ className?: string }>) {
  const t = useTranslations('languageSwitcher');
  const locale = useLocale();
  const pathname = usePathname() ?? '/';

  return (
    <nav aria-label={t('label')} className={className}>
      <ul className="flex items-center">
        {routing.locales.map((target) => {
          const isCurrent = target === locale;
          return (
            <li key={target} className="flex items-center">
              <Link
                href={pathname}
                locale={target}
                lang={target}
                aria-current={isCurrent ? 'true' : undefined}
                className={`min-h-[44px] px-2.5 inline-flex items-center rounded-sm text-sm transition-colors ${
                  isCurrent ? 'font-semibold text-ink' : 'font-medium text-ink-2 hover:text-ink'
                }`}
              >
                {LANGUAGE_NAMES[target]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
