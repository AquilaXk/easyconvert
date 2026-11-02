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
          dailyLimit={dailyLimit}
          activeSourceFormat={queue.length > 0 ? queue[0].sourceFormat : undefined}
          activeTargetFormat={queue.length > 0 ? queue[0].targetFormat || 'any' : undefined}
        />

        {queue.length > 0 && (
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
            onImportFile={(file) => handleFilesSelected([file], queue[0]?.targetFormat || undefined)}
            onDownloadAllZip={() => {
              void handleDownloadAllZip();
            }}
            isConverting={isConverting}
            zipError={zipError}
            onDismissZipError={clearZipError}
          />
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
