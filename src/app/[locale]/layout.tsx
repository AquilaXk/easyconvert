import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { clientMessages } from '@/i18n/client-messages';
import { routing } from '@/i18n/routing';
import { siteMetadataBase } from '@/i18n/metadata';
import '../globals.css';

// One OFL sans for Latin and Hangul: a subset of Pretendard Variable (scripts/subset-web-font.py), vendored so a build
// needs no network (licence beside the files). Text the messages do not hold falls back to the system sans.
const uiFont = localFont({
  src: '../fonts/EasyConvertSans-subset.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-ui',
  adjustFontFallback: 'Arial',
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
    <html lang={locale} className={uiFont.variable} suppressHydrationWarning>
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
