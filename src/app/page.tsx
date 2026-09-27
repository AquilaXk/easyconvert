'use client';

import React from 'react';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import ConversionQueue from '@/components/ConversionQueue';
import Features from '@/components/Features';
import FaqSection from '@/components/FaqSection';
import AdBanner from '@/components/AdBanner';
import Footer from '@/components/Footer';
import { useClientQueue } from '@/hooks/useClientQueue';

export default function Home() {
  const {
    queue,
    isConverting,
    setPresetTarget,
    handleFilesSelected,
    handleRemoveItem,
    handleClearAll,
    handleUpdateTargetFormat,
    handleUpdateAllTargets,
    handleUpdateOptions,
    convertSingleItem,
    handleConvertAll,
    handleDownloadAllZip,
  } = useClientQueue({ bundlePrefix: 'easyconvert_bundle' });

  const handleSelectPreset = (source: string, target: string) => {
    setPresetTarget(target);
    const input = document.getElementById('main-file-input') as HTMLInputElement;
    if (input) {
      input.click();
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text transition-colors">
      <Header />

      {/* Top Leaderboard Ad Unit */}
      <AdBanner slot="top-leaderboard" className="pt-2 pb-0" />

      <main className="flex-1">
        {/* Modern Dropzone & Format Hero Section */}
        <Hero
          onFilesSelected={handleFilesSelected}
          hasActiveQueue={queue.length > 0}
          activeSourceFormat={queue.length > 0 ? queue[0].sourceFormat : undefined}
          activeTargetFormat={queue.length > 0 ? (queue[0].targetFormat || 'any') : undefined}
        />

        {/* Floating Queue Table when files are added */}
        {queue.length > 0 && (
          <div className="relative z-20 max-w-8xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 mb-14 animate-in fade-in duration-200 pb-24">
            <ConversionQueue
              items={queue}
              onRemoveItem={handleRemoveItem}
              onClearAll={handleClearAll}
              onUpdateTargetFormat={handleUpdateTargetFormat}
              onUpdateAllTargets={handleUpdateAllTargets}
              onUpdateOptions={handleUpdateOptions}
              onConvertAll={handleConvertAll}
              onConvertSingle={(id) => {
                const target = queue.find((i) => i.id === id);
                if (target) convertSingleItem(target);
              }}
              onAddMoreFiles={() => {
                const input = document.getElementById('main-file-input') as HTMLInputElement;
                if (input) input.click();
              }}
              onDownloadAllZip={handleDownloadAllZip}
              isConverting={isConverting}
            />
          </div>
        )}

        {/* Informational & conversion content when queue is idle */}
        {queue.length === 0 && (
          <>
            {/* Mid-Content Ad Banner */}
            <AdBanner slot="mid-content" />

            {/* 3-Step Guide, Format Catalog & High-Fidelity Highlights */}
            <Features onSelectPreset={handleSelectPreset} />

            {/* In-Feed Ad Banner */}
            <AdBanner slot="in-feed" />

            {/* Comprehensive Free & Secure FAQ Section */}
            <FaqSection />
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
