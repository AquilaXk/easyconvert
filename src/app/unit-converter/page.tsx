import React from 'react';
import type { Metadata } from 'next';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import UnitConverter from '@/components/UnitConverter';
import AdBanner from '@/components/AdBanner';
import FaqSection from '@/components/FaqSection';

export const metadata: Metadata = {
  title: 'Free Online Unit Converter | EasyConvert',
  description:
    'Convert length, weight, temperature, volume, area, speed, time, digital storage, energy, and pressure units directly in your browser.',
};

export default function UnitConverterPage() {
  return (
    <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
      <Header />

      <main id="main-content" className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold tracking-tight text-brand-950 dark:text-white">
            Universal Unit Converter
          </h1>
          <p className="mt-2 text-sm sm:text-base text-ink-secondary dark:text-neutral-400 max-w-3xl">
            Convert measurements across 10 physical and digital categories with bidirectional calculations and multi-unit reference tables.
          </p>
        </div>

        <UnitConverter />

        <div className="mt-12 min-h-[50px] sm:min-h-[64px] flex items-center justify-center">
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
