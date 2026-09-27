import React from 'react';
import type { Metadata } from 'next';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import UnitConverter from '@/components/UnitConverter';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';

export const metadata: Metadata = {
  title: 'Free Online Unit Converter — EasyConvert',
  description:
    'Convert length, weight, temperature, volume, area, speed, time, digital storage, and pressure units instantly in your browser with zero latency and 100% privacy.',
};

export default function UnitConverterPage() {
  return (
    <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
      <Header />

      <AdBanner slot="top-leaderboard" className="pt-2 pb-0" />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        {/* Page Header */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-brand-100 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-300 dark:border-white/10 mb-3">
            <span>Instant Client-Side Calculation</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-brand-950 dark:text-white">
            Universal Unit Converter
          </h1>
          <p className="mt-3 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-2xl mx-auto">
            Convert measurements across 10 categories with scientific accuracy, bidirectional calculations, and comprehensive multi-unit comparison tables.
          </p>
        </div>

        {/* Unit Converter Component */}
        <UnitConverter />

        <div className="mt-16">
          <AdBanner slot="mid-content" />
        </div>

        <div className="mt-12">
          <FaqSection />
        </div>
      </main>

      <Footer />
    </div>
  );
}
