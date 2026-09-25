'use client';

import React, { useState } from 'react';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import ConversionQueue from '@/components/ConversionQueue';
import Features from '@/components/Features';
import FormatExplorer from '@/components/FormatExplorer';
import FaqSection from '@/components/FaqSection';
import Footer from '@/components/Footer';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY } from '@/lib/registry';

export default function Home() {
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);

  // Add files to queue
  const handleFilesSelected = (files: File[], defaultTarget?: string) => {
    const newItems: ConversionQueueItem[] = files.map((file) => {
      const detected = detectFormatFromFilename(file.name);
      const sourceFormat = detected ? detected.extension : file.name.split('.').pop() || 'bin';

      let targetFormat = defaultTarget || 'pdf';
      if (detected && detected.targetFormats.length > 0) {
        if (!detected.targetFormats.includes(targetFormat.toLowerCase())) {
          targetFormat = detected.targetFormats[0];
        }
      }

      return {
        id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
        file,
        name: file.name,
        size: file.size,
        sourceFormat,
        targetFormat,
        status: 'ready',
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

  const handleUpdateOptions = (id: string, options: ConversionOptions) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, options } : item))
    );
  };

  // Convert a single item
  const convertSingleItem = async (item: ConversionQueueItem): Promise<void> => {
    setQueue((prev) =>
      prev.map((i) =>
        i.id === item.id ? { ...i, status: 'converting', progress: 30, error: undefined } : i
      )
    );

    try {
      const formData = new FormData();
      formData.append('file', item.file);
      formData.append('targetFormat', item.targetFormat);
      formData.append('options', JSON.stringify(item.options));

      const res = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({ error: 'Conversion failed' }));
        throw new Error(errorJson.error || `Server returned error (${res.status})`);
      }

      const blob = await res.blob();
      const resultUrl = URL.createObjectURL(blob);

      setQueue((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? {
                ...i,
                status: 'completed',
                progress: 100,
                resultUrl,
                resultSize: blob.size,
              }
            : i
        )
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Conversion failed';
      setQueue((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, status: 'error', progress: 0, error: msg } : i
        )
      );
    }
  };

  // Convert all ready items
  const handleConvertAll = async () => {
    const readyItems = queue.filter((i) => i.status === 'ready' || i.status === 'error');
    if (readyItems.length === 0) return;

    setIsConverting(true);
    for (const item of readyItems) {
      await convertSingleItem(item);
    }
    setIsConverting(false);
  };

  // Download all completed items as consolidated ZIP archive
  const handleDownloadAllZip = async () => {
    const completedItems = queue.filter((i) => i.status === 'completed' && i.resultUrl);
    if (completedItems.length === 0) return;

    try {
      const zip = new JSZip();
      const usedNames = new Set<string>();

      for (const item of completedItems) {
        if (!item.resultUrl) continue;
        const res = await fetch(item.resultUrl);
        const blob = await res.blob();

        const base = item.name.replace(/\.[^/.]+$/, '');
        let outputName = `${base}.${item.targetFormat}`;
        let counter = 1;
        while (usedNames.has(outputName)) {
          outputName = `${base} (${counter}).${item.targetFormat}`;
          counter++;
        }
        usedNames.add(outputName);

        zip.file(outputName, blob);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipUrl = URL.createObjectURL(zipBlob);

      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = 'easyconvert_bundle.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(zipUrl);
    } catch (err) {
      alert('Could not download batch zip: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleSelectPreset = (source: string, target: string) => {
    const input = document.getElementById('main-file-input') as HTMLInputElement;
    if (input) {
      input.click();
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main className="flex-1">
        <Hero
          onFilesSelected={handleFilesSelected}
          hasActiveQueue={queue.length > 0}
        />

        {queue.length > 0 && (
          <div className="max-w-6xl mx-auto px-4 sm:px-6 -mt-8 mb-16 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <ConversionQueue
              items={queue}
              onRemoveItem={handleRemoveItem}
              onClearAll={handleClearAll}
              onUpdateTargetFormat={handleUpdateTargetFormat}
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

        <Features />
        <FormatExplorer onSelectPreset={handleSelectPreset} />
        <FaqSection />
      </main>

      <Footer />
    </div>
  );
}
