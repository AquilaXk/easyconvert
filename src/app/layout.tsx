import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EasyConvert — File Converter Online',
  description:
    'Universal online file converter supporting images, documents, spreadsheets, data structures, and archives with modern high-fidelity conversion engine.',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
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
      <body className="min-h-screen flex flex-col antialiased bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text selection:bg-brand-200 selection:text-brand-900">
        {children}
      </body>
    </html>
  );
}
