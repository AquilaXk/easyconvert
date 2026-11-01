'use client';

import React, { useId, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing, type AppLocale } from '@/i18n/routing';

/** Each language is named in itself, so a reader finds theirs whatever the page's language is. */
const LANGUAGE_NAMES: Readonly<Record<AppLocale, string>> = {
  en: 'English',
  ko: '한국어',
};

function isAppLocale(value: string): value is AppLocale {
  return (routing.locales as readonly string[]).includes(value);
}

/**
 * Switches the page to another language at the same path, query and fragment. The router writes the locale cookie, so the
 * root opens in the chosen language next time.
 */
export default function LanguageSwitcher({ className = '' }: Readonly<{ className?: string }>) {
  const t = useTranslations('languageSwitcher');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const selectId = useId();

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isAppLocale(next) || next === locale) return;
    const href = `${pathname}${window.location.search}${window.location.hash}`;
    startTransition(() => {
      router.replace(href, { locale: next, scroll: false });
    });
  };

  return (
    <div className={className}>
      <label htmlFor={selectId} className="sr-only">
        {t('label')}
      </label>
      <select
        id={selectId}
        value={locale}
        disabled={isPending}
        onChange={handleChange}
        className="select-chevron min-h-[44px] pl-3 pr-9 rounded-sm bg-transparent text-sm font-medium text-ink-2 hover:text-ink cursor-pointer transition-colors disabled:opacity-50"
      >
        {routing.locales.map((value) => (
          <option key={value} value={value} lang={value}>
            {LANGUAGE_NAMES[value]}
          </option>
        ))}
      </select>
    </div>
  );
}
