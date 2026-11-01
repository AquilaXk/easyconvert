import type { Metadata } from 'next';
import { Instrument_Sans, Instrument_Serif } from 'next/font/google';
import ParallaxDriver from '@/components/ParallaxDriver';
import './globals.css';

const uiFont = Instrument_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-ui' });
const displayFont = Instrument_Serif({ subsets: ['latin'], weight: '400', display: 'swap', variable: '--font-display' });

export const metadata: Metadata = {
  title: 'EasyConvert | Online File Converter',
  description:
    'Convert documents, images, audio, video, spreadsheets, structured data, and archives online with encrypted ephemeral processing.',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${uiFont.variable} ${displayFont.variable}`} suppressHydrationWarning>
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
        <ParallaxDriver />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:px-4 focus:py-2.5 focus:rounded-sm focus:bg-accent focus:text-on-accent focus:text-sm focus:font-semibold"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
