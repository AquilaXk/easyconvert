'use client';

import { usePathname } from 'next/navigation';
import { GLOBAL_ERROR_COPY } from '@/lib/global-error-copy';
import './globals.css';

const HOME_HREF = { en: '/', ko: '/ko' } as const;

const ACTION_CLASS = 'inline-flex items-center justify-center h-8 [@media(pointer:coarse)]:h-11 px-4 rounded-xs text-sm font-medium transition-colors';

/** The error boundary of the root layout itself, which replaces it: no provider is there, so the page carries its own markup and copy, in the language of the path, with the site's stylesheet and tokens. */
export default function GlobalError({ reset }: Readonly<{ reset: () => void }>) {
  const locale = usePathname()?.split('/')[1] === 'ko' ? 'ko' : 'en';
  const copy = GLOBAL_ERROR_COPY[locale];

  return (
    <html lang={locale}>
      <body>
        <main className="min-h-screen flex flex-col items-center justify-center px-4 sm:px-6 py-16 text-center">
          <h1 className="max-w-2xl text-2xl sm:text-3xl text-ink break-keep break-words">{copy.title}</h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-ink-2 break-keep">{copy.description}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button type="button" onClick={reset} className={`${ACTION_CLASS} bg-accent text-on-accent hover:bg-accent-hover cursor-pointer`}>
              {copy.retry}
            </button>
            <a href={HOME_HREF[locale]} className={`${ACTION_CLASS} text-ink-2 hover:text-ink hover:bg-sunken/50`}>
              {copy.home}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
