'use client';

import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY } from '@/lib/registry';
import { createItemConverter, getEffectiveMaxFileSize } from '@/lib/client-converter';

declare global {
  interface Window {
    __addTestFile?: (name: string, target?: string) => void;
  }
}

interface UseClientQueueOptions {
  defaultTarget?: string;
  bundlePrefix?: string;
}

function createQueueItemId(fileName: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${fileName}`;
}

function resolveInitialTargetFormat(
  supportedTargets: string[] | undefined,
  effectiveDefault: string | undefined
): string {
  if (!effectiveDefault || effectiveDefault.toLowerCase() === 'any') {
    return '';
  }
  const preferredFmt = effectiveDefault.toLowerCase();
  if (supportedTargets && supportedTargets.length > 0) {
    return supportedTargets.includes(preferredFmt) ? preferredFmt : '';
  }
  return preferredFmt;
}

function buildUniqueArchiveName(
  itemName: string,
  targetFormat: string,
  usedFilenames: Set<string>
): string {
  const dotIndex = itemName.lastIndexOf('.');
  const baseName = (dotIndex > 0 ? itemName.substring(0, dotIndex) : itemName) || itemName;
  let candidate = `${baseName}.${targetFormat}`;
  let counter = 1;
  while (usedFilenames.has(candidate)) {
    candidate = `${baseName}_(${counter}).${targetFormat}`;
    counter += 1;
  }
  usedFilenames.add(candidate);
  return candidate;
}

export function useClientQueue(options?: UseClientQueueOptions) {
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [presetTarget, setPresetTarget] = useState<string>('');
  const [zipError, setZipError] = useState<string | null>(null);

  const handleFilesSelected = (files: File[], overrideTarget?: string) => {
    const maxLimit = getEffectiveMaxFileSize();
    const effectiveDefault = overrideTarget || presetTarget || options?.defaultTarget;
    if (presetTarget) {
      setPresetTarget('');
    }

    const newItems: ConversionQueueItem[] = files.map((file) => {
      const detected = detectFormatFromFilename(file.name);
      const sourceFormat = detected ? detected.extension : file.name.split('.').pop() || 'bin';
      const targetFormat = resolveInitialTargetFormat(detected?.targetFormats, effectiveDefault);
      const isOverSize = file.size > maxLimit;

      return {
        id: createQueueItemId(file.name),
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

  const handleFilesSelectedRef = useRef(handleFilesSelected);
  handleFilesSelectedRef.current = handleFilesSelected;

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    window.__addTestFile = (name: string, target?: string) => {
      const file = new File(['mock test data content'], name, { type: 'application/pdf' });
      handleFilesSelectedRef.current([file], target);
    };
    return () => {
      delete window.__addTestFile;
    };
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
      if (item.resultUrl) {
        URL.revokeObjectURL(item.resultUrl);
      }
    });
    setZipError(null);
    setQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, targetFormat: string) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, targetFormat } : item))
    );
  };

  const handleUpdateAllTargets = (targetFormat: string) => {
    const normalizedTarget = targetFormat.toLowerCase();
    setQueue((prev) =>
      prev.map((item) => {
        const def = FORMAT_REGISTRY[item.sourceFormat];
        if (def && def.targetFormats.includes(normalizedTarget)) {
          return { ...item, targetFormat: normalizedTarget };
        }
        return item;
      })
    );
  };

  const handleUpdateOptions = (id: string, nextOptions: ConversionOptions) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, options: nextOptions } : item))
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

  const clearZipError = () => {
    setZipError(null);
  };

  const handleDownloadAllZip = async () => {
    const completedItems = queue.filter((i) => i.status === 'completed' && i.resultUrl);
    if (completedItems.length === 0) {
      return;
    }

    setZipError(null);
    try {
      const zip = new JSZip();
      const usedFilenames = new Set<string>();

      for (const item of completedItems) {
        if (!item.resultUrl) {
          continue;
        }
        const res = await fetch(item.resultUrl);
        const blob = await res.blob();
        const archiveFilename = buildUniqueArchiveName(item.name, item.targetFormat, usedFilenames);
        zip.file(archiveFilename, blob);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipUrl = URL.createObjectURL(zipBlob);
      const anchor = document.createElement('a');
      anchor.href = zipUrl;
      const prefix = options?.bundlePrefix || 'easyconvert_bundle';
      anchor.download = `${prefix}_${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(zipUrl);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'Unknown error';
      setZipError(`Could not build ZIP archive. ${detail}`);
    }
  };

  return {
    queue,
    setQueue,
    isConverting,
    presetTarget,
    setPresetTarget,
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
  };
}
