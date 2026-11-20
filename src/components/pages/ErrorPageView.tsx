'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

const ACTION_CLASS = 'inline-flex items-center justify-center h-8 [@media(pointer:coarse)]:h-11 px-4 rounded-xs text-sm font-medium transition-colors';

/** What a page that failed to render shows: centred a small code, one heading, one sentence, then a retry button and a link home. */
export default function ErrorPageView({ reset }: Readonly<{ reset: () => void }>) {
  const t = useTranslations('errorPage');

  return (
    <main id="main-content" className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-16 text-center">
      <p className="text-sm font-semibold text-ink-3">{t('code')}</p>
      <h1 className="mt-3 max-w-2xl text-2xl sm:text-3xl text-ink break-keep break-words">{t('title')}</h1>
      <p className="mt-4 max-w-xl text-sm leading-6 text-ink-2 break-keep">{t('description')}</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={reset} className={`${ACTION_CLASS} bg-accent text-on-accent hover:bg-accent-hover cursor-pointer`}>
          {t('retry')}
        </button>
        <Link href="/" className={`${ACTION_CLASS} text-ink-2 hover:text-ink hover:bg-sunken/50`}>
          {t('home')}
        </Link>
      </div>
    </main>
  );
}
