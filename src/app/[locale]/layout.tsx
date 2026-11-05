import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { clientMessages } from '@/i18n/client-messages';
import { routing } from '@/i18n/routing';
import { siteMetadataBase } from '@/i18n/metadata';
import '../globals.css';

// One OFL sans for Latin and Hangul, cut from Pretendard Variable into two files by scripts/subset-web-font.py and vendored
// so a build needs no network (licence beside the files). Both carry the family name EasyConvert Sans. Latin is preloaded
// and holds the language name every page shows; Hangul is fetched only by a page that draws another syllable of the
// unicode-range below, so an English page loads Latin alone.
// Text the messages do not hold falls back to the system sans.
const latinFont = localFont({
  src: '../fonts/EasyConvertSans-latin.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-ui',
  adjustFontFallback: 'Arial',
});

const hangulFont = localFont({
  src: '../fonts/EasyConvertSans-hangul.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-ui-hangul',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+1100-11FF, U+3130-318F, U+AC00-D7A3' }],
});

interface LocaleLayoutProps {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

/**
 * The locales are the only values of this segment. Every non-asset path goes through the locale middleware, which rewrites
 * unprefixed paths under the default locale, and keeping `dynamicParams` off ensures the static pages under `[locale]` are
 * never rendered for any other segment.
 */
export const dynamicParams = false;

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
  };
}

export default async function LocaleLayout({ children, params }: Readonly<LocaleLayoutProps>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const [t, messages] = await Promise.all([getTranslations('layout'), getMessages()]);

  return (
    <html lang={locale} className={`${latinFont.variable} ${hangulFont.variable}`} suppressHydrationWarning>
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
