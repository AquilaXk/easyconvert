'use client';

import { usePathname } from 'next/navigation';
import { GLOBAL_ERROR_COPY } from '@/lib/global-error-copy';

const HOME_HREF = { en: '/', ko: '/ko' } as const;

const ACTION_STYLE = { padding: '0.5rem 1rem', borderRadius: 4, fontSize: 14, fontWeight: 500, textDecoration: 'none', cursor: 'pointer' } as const;

/** The error boundary of the root layout itself, which replaces it: no provider or stylesheet is there, so the page carries its own markup, styles and copy, in the language of the path. */
export default function GlobalError({ reset }: Readonly<{ reset: () => void }>) {
  const locale = usePathname()?.split('/')[1] === 'ko' ? 'ko' : 'en';
  const copy = GLOBAL_ERROR_COPY[locale];

  return (
    <html lang={locale}>
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', colorScheme: 'light dark' }}>
        <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 1rem', textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 600 }}>{copy.title}</h1>
          <p style={{ margin: '1rem 0 2rem', maxWidth: 560, fontSize: 16, opacity: 0.75 }}>{copy.description}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
            <button type="button" onClick={reset} style={{ ...ACTION_STYLE, border: 'none', background: '#2563eb', color: '#fff' }}>
              {copy.retry}
            </button>
            <a href={HOME_HREF[locale]} style={{ ...ACTION_STYLE, color: 'inherit', border: '1px solid currentColor' }}>
              {copy.home}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
