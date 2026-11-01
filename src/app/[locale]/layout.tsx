import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import WovenGround from '@/components/WovenGround';
import { clientMessages } from '@/i18n/client-messages';
import { routing } from '@/i18n/routing';
import { siteMetadataBase } from '@/i18n/metadata';
import '../globals.css';

// Latin subsets of the two OFL families, vendored so a build needs no network (licences beside the files). Their middle
// dot advances 0.1 em, so an unspaced Korean 가운뎃점 between two syllables vanished: the faces leave U+00B7 to the
// metric-matched fallback below them (next/font takes only literal options, so the range is written out twice).
const uiFont = localFont({
  src: '../fonts/InstrumentSans-latin.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-ui',
  adjustFontFallback: 'Arial',
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00B6, U+00B8-10FFFF' }],
});
const displayFont = localFont({
  src: '../fonts/InstrumentSerif-latin.woff2',
  weight: '400',
  display: 'swap',
  variable: '--font-display',
  adjustFontFallback: 'Times New Roman',
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00B6, U+00B8-10FFFF' }],
});
// Instrument Serif has no Hangul: Korean headings take theirs from an OFL Noto Serif KR subset of the Korean messages
// (scripts/subset-hangul-display-font.py), which a page downloads only when it shows Hangul in a display face.
const displayHangulFont = localFont({
  src: '../fonts/NotoSerifKR-hangul-display.woff2',
  weight: '400',
  display: 'swap',
  variable: '--font-display-hangul',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+1100-11FF, U+2192, U+3130-318F, U+AC00-D7A3' }],
});

interface LocaleLayoutProps {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Omit<LocaleLayoutProps, 'children'>): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'meta.site' });
  return {
    metadataBase: siteMetadataBase(),
    title: t('title'),
    description: t('description'),
    icons: {
      icon: '/icon.svg',
      shortcut: '/icon.svg',
      apple: '/icon.svg',
    },
  };
}

export default async function LocaleLayout({ children, params }: Readonly<LocaleLayoutProps>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const [t, messages] = await Promise.all([getTranslations('layout'), getMessages()]);

  return (
    <html lang={locale} className={`${uiFont.variable} ${displayFont.variable} ${displayHangulFont.variable}`} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.remove('dark');
                }
              } catch (_) {}
            `,
          }}
        />
      </head>
      <body className="min-h-screen flex flex-col antialiased font-sans">
        <NextIntlClientProvider messages={clientMessages(messages, 'layout')}>
          <WovenGround />
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:px-4 focus:py-2.5 focus:rounded-sm focus:bg-accent focus:text-on-accent focus:text-sm focus:font-semibold"
          >
            {t('skipToContent')}
          </a>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
