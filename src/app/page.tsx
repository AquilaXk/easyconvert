'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import ConversionQueue from '@/components/ConversionQueue';
import Features from '@/components/Features';
import Footer from '@/components/Footer';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY } from '@/lib/registry';
import { createItemConverter } from '@/lib/client-converter';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export default function Home() {
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [presetTarget, setPresetTarget] = useState<string>('');

  // Add files to queue
  const handleFilesSelected = (files: File[], defaultTarget?: string) => {
    const newItems: ConversionQueueItem[] = files.map((file) => {
      const detected = detectFormatFromFilename(file.name);
      const sourceFormat = detected ? detected.extension : file.name.split('.').pop() || 'bin';

      let targetFormat = '';
      const preferred = defaultTarget || presetTarget;
      if (preferred && preferred.toLowerCase() !== 'any') {
        if (detected && detected.targetFormats.length > 0) {
          if (detected.targetFormats.includes(preferred.toLowerCase())) {
            targetFormat = preferred.toLowerCase();
          }
        } else {
          targetFormat = preferred.toLowerCase();
        }
      }

      const isOverSize = file.size > MAX_FILE_SIZE;

      return {
        id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
        file,
        name: file.name,
        size: file.size,
        sourceFormat,
        targetFormat,
        status: isOverSize ? 'error' : 'ready',
        error: isOverSize ? 'File exceeds 100 MB real-time conversion limit.' : undefined,
        progress: 0,
        options: {
          quality: 85,
          fit: 'contain',
          stripMetadata: false,
          orientation: 'portrait',
          delimiter: ',',
          compressionLevel: 6,
        },
      };
    });

    setQueue((prev) => [...prev, ...newItems]);
  };

  React.useEffect(() => {
    (window as any).__addTestFile = (name: string, target?: string) => {
      const f = new File(['mock test data content'], name, { type: 'application/pdf' });
      handleFilesSelected([f], target);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRemoveItem = (id: string) => {
    setQueue((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target?.resultUrl) {
        URL.revokeObjectURL(target.resultUrl);
      }
      return prev.filter((i) => i.id !== id);
    });
  };

  const handleClearAll = () => {
    queue.forEach((item) => {
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    });
    setQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, targetFormat: string) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, targetFormat } : item))
    );
  };

  const handleUpdateAllTargets = (targetFormat: string) => {
    setQueue((prev) =>
      prev.map((item) => {
        const def = FORMAT_REGISTRY[item.sourceFormat];
        if (def && def.targetFormats.includes(targetFormat.toLowerCase())) {
          return { ...item, targetFormat };
        }
        return item;
      })
    );
  };

  const handleUpdateOptions = (id: string, options: ConversionOptions) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, options } : item))
    );
  };

  // Convert a single item
  const convertSingleItem = createItemConverter(setQueue, MAX_FILE_SIZE);

  // Convert all ready/error items
  const handleConvertAll = async () => {
    setIsConverting(true);
    const pendingItems = queue.filter((i) => i.status === 'ready' || i.status === 'error');

    for (const item of pendingItems) {
      await convertSingleItem(item);
    }
    setIsConverting(false);
  };

  // Download all completed items bundled in a client-side ZIP
  const handleDownloadAllZip = async () => {
    const completedItems = queue.filter((i) => i.status === 'completed' && i.resultUrl);
    if (completedItems.length === 0) return;

    try {
      const zip = new JSZip();
      const usedFilenames = new Set<string>();

      for (const item of completedItems) {
        if (!item.resultUrl) continue;
        const res = await fetch(item.resultUrl);
        const blob = await res.blob();

        const baseName = item.name.substring(0, item.name.lastIndexOf('.')) || item.name;
        let finalFilename = `${baseName}.${item.targetFormat}`;

        let counter = 1;
        while (usedFilenames.has(finalFilename)) {
          finalFilename = `${baseName}_(${counter}).${item.targetFormat}`;
          counter++;
        }
        usedFilenames.add(finalFilename);

        zip.file(finalFilename, blob);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `easyconvert_bundle_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(zipUrl);
    } catch (err: unknown) {
      alert('Could not download consolidated ZIP: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleSelectPreset = (source: string, target: string) => {
    setPresetTarget(target);
    const input = document.getElementById('main-file-input') as HTMLInputElement;
    if (input) {
      input.click();
    }
  };

  return (
    <div className={`flex flex-col min-h-screen ${queue.length > 0 ? 'bg-[#18191d]' : 'bg-[#f4f4f5] dark:bg-[#18191d]'} text-neutral-900 dark:text-neutral-100 transition-colors`}>
      <Header />

      <main className="flex-1">
        {/* Dark Hero Section */}
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

        {/* 2-Column Format Catalog & Data Security */}
        {queue.length === 0 && <Features onSelectPreset={handleSelectPreset} />}
      </main>

      {queue.length === 0 && <Footer />}
    </div>
  );
}
