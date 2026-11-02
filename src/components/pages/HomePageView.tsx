'use client';

import React from 'react';
import Header from '@/components/Header';
import { HomeHero, QueueHeader } from '@/components/Hero';
import { MAIN_FILE_INPUT_ID } from '@/components/hero/useHeroUpload';
import ConversionQueue from '@/components/ConversionQueue';
import Features from '@/components/Features';
import FaqSection from '@/components/FaqSection';
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
    handleConvertAll,
    handleDownloadAllZip,
  } = useClientQueue({ bundlePrefix: 'easyconvert_bundle' });

  const handleOpenFilePicker = () => {
    const input = document.getElementById(MAIN_FILE_INPUT_ID);
    if (input instanceof HTMLInputElement) {
      input.click();
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main id="main-content" className="flex-1">
        {queue.length > 0 ? (
          <QueueHeader onFilesSelected={handleFilesSelected} sourceFormat={queue[0].sourceFormat} targetFormat={queue[0].targetFormat} />
        ) : (
          <HomeHero onFilesSelected={handleFilesSelected} dailyLimit={dailyLimit} />
        )}

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
            <FaqSection dailyLimit={dailyLimit} />
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
