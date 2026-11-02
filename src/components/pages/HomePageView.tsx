'use client';

import React, { useMemo } from 'react';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import ConversionQueue from '@/components/ConversionQueue';
import Features from '@/components/Features';
import FaqSection from '@/components/FaqSection';
import AdBanner from '@/components/AdBanner';
import Footer from '@/components/Footer';
import { useClientQueue } from '@/hooks/useClientQueue';
import type { QueueSummary } from '@/components/workbench/hero-copy';

/** The home page; `dailyLimit` is the anonymous daily allowance the server enforces, read on the server. */
export default function HomePageView({ dailyLimit }: Readonly<{ dailyLimit: number }>) {
  const {
    queue,
    isConverting,
    zipError,
    clearZipError,
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

  const activeQueueSummary = useMemo<QueueSummary | undefined>(() => {
    if (queue.length === 0) return undefined;
    return {
      count: queue.length,
      sourceFormats: Array.from(new Set(queue.map((item) => item.sourceFormat))),
      targetFormats: Array.from(new Set(queue.map((item) => item.targetFormat.trim()).filter(Boolean))),
    };
  }, [queue]);

  const handleOpenFilePicker = () => {
    const input = document.getElementById('main-file-input');
    if (input instanceof HTMLInputElement) {
      input.click();
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main id="main-content" className="flex-1">
        <Hero
          onFilesSelected={handleFilesSelected}
          hasActiveQueue={queue.length > 0}
          activeSourceFormat={queue.length > 0 ? queue[0].sourceFormat : undefined}
          activeTargetFormat={queue.length > 0 ? queue[0].targetFormat || 'any' : undefined}
          activeQueueSummary={activeQueueSummary}
        />

        {queue.length > 0 && (
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <ConversionQueue
              items={queue}
              onRemoveItem={handleRemoveItem}
              onClearAll={handleClearAll}
              onUpdateTargetFormat={handleUpdateTargetFormat}
              onUpdateAllTargets={handleUpdateAllTargets}
              onUpdateOptions={handleUpdateOptions}
              onConvertAll={() => {
                void handleConvertAll();
              }}
              onConvertSingle={(id) => {
                const target = queue.find((item) => item.id === id);
                if (target) {
                  void convertSingleItem(target);
                }
              }}
              onAddMoreFiles={handleOpenFilePicker}
              onDownloadAllZip={() => {
                void handleDownloadAllZip();
              }}
              isConverting={isConverting}
              zipError={zipError}
              onDismissZipError={clearZipError}
            />
          </div>
        )}

        {queue.length === 0 && (
          <>
            <Features />
            <AdBanner slot="mid-content" />
            <FaqSection dailyLimit={dailyLimit} />
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
