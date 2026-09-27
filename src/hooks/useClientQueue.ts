'use client';

import React, { useState, useEffect } from 'react';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY } from '@/lib/registry';
import { createItemConverter, getEffectiveMaxFileSize } from '@/lib/client-converter';

interface UseClientQueueOptions {
  defaultTarget?: string;
  bundlePrefix?: string;
}

export function useClientQueue(options?: UseClientQueueOptions) {
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [presetTarget, setPresetTarget] = useState<string>('');

  const handleFilesSelected = (files: File[], overrideTarget?: string) => {
    const maxLimit = getEffectiveMaxFileSize();
    const effectiveDefault = overrideTarget || presetTarget || options?.defaultTarget;
    if (presetTarget) {
      setPresetTarget('');
    }

    const newItems: ConversionQueueItem[] = files.map((file) => {
      const detected = detectFormatFromFilename(file.name);
      const sourceFormat = detected ? detected.extension : file.name.split('.').pop() || 'bin';

      let targetFormat = '';
      if (effectiveDefault && effectiveDefault.toLowerCase() !== 'any') {
        const preferredFmt = effectiveDefault.toLowerCase();
        if (detected && detected.targetFormats.length > 0) {
          if (detected.targetFormats.includes(preferredFmt)) {
            targetFormat = preferredFmt;
          }
        } else {
          targetFormat = preferredFmt;
        }
      }

      const isOverSize = file.size > maxLimit;

      return {
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `item-${Date.now()}-${file.name}`,
        file,
        name: file.name,
        size: file.size,
        sourceFormat: sourceFormat.toLowerCase(),
        targetFormat: targetFormat.toLowerCase(),
        status: isOverSize ? 'error' : 'ready',
        error: isOverSize
          ? `File exceeds ${Math.round(maxLimit / (1024 * 1024))} MB real-time conversion limit.`
          : undefined,
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

  useEffect(() => {
    (window as any).__addTestFile = (name: string, target?: string) => {
      const f = new File(['mock test data content'], name, { type: 'application/pdf' });
      handleFilesSelected([f], target);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.defaultTarget]);

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

  const convertSingleItem = createItemConverter(setQueue);

  const handleConvertAll = async () => {
    setIsConverting(true);
    const pendingItems = queue.filter((i) => i.status === 'ready' || i.status === 'error');

    for (const item of pendingItems) {
      await convertSingleItem(item);
    }
    setIsConverting(false);
  };

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
      const prefix = options?.bundlePrefix || 'easyconvert_bundle';
      a.download = `${prefix}_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(zipUrl);
    } catch (err: unknown) {
      alert('Could not download consolidated ZIP: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  return {
    queue,
    setQueue,
    isConverting,
    presetTarget,
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
  };
}
