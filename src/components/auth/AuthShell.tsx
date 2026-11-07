import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

/** The frame of the pages of the sign-in family: the site header and footer around one narrow card. */
export function AuthShell({ heading, intro, children }: Readonly<{ heading: string; intro?: string; children: React.ReactNode }>) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main id="main-content" className="flex-1 flex items-start justify-center pt-8 pb-12 px-6">
        <div className="bg-surface max-w-md w-full border border-rule p-6">
          <div className="text-center">
            <h1 className="text-xl font-semibold text-ink">{heading}</h1>
            {intro && <p className="mt-1 text-base text-ink-3">{intro}</p>}
          </div>
          <div className="mt-6">{children}</div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
