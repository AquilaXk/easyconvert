'use client';

import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import {
  detectFormatFromFilename,
  FORMAT_REGISTRY,
  getAvailableTargetFormats,
} from '@/lib/registry';
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

const DEFAULT_ITEM_OPTIONS: ConversionOptions = {
  quality: 85,
  fit: 'contain',
  stripMetadata: false,
  orientation: 'portrait',
  delimiter: ',',
  compressionLevel: 6,
};

function createQueueItemId(fileName: string): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `item-${Date.now()}-${fileName}`;
}

function revokeBlobIfNeeded(url?: string): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

function resolveInitialTargetFormat(sourceFormat: string, effectiveDefault?: string): string {
  if (!effectiveDefault || effectiveDefault.toLowerCase() === 'any') return '';
  const cleanTarget = effectiveDefault.toLowerCase();
  const normalizedSource = sourceFormat.toLowerCase();
  if (!FORMAT_REGISTRY[normalizedSource]) {
    return FORMAT_REGISTRY[cleanTarget]?.available === false ? '' : cleanTarget;
  }
  return getAvailableTargetFormats(normalizedSource).some((f) => f.id === cleanTarget)
    ? cleanTarget
    : '';
}

function resetItemIfFinished(
  item: ConversionQueueItem,
  patch: Pick<ConversionQueueItem, 'targetFormat' | 'options'>
): ConversionQueueItem {
  if (item.status !== 'completed' && item.status !== 'error') return { ...item, ...patch };
  revokeBlobIfNeeded(item.resultUrl);
  return {
    id: item.id,
    file: item.file,
    name: item.name,
    size: item.size,
    sourceFormat: item.sourceFormat,
    targetFormat: patch.targetFormat,
    options: patch.options,
    status: 'ready',
    progress: 0,
  };
}

function buildUniqueArchiveName(itemName: string, targetFormat: string, used: Set<string>): string {
  const dot = itemName.lastIndexOf('.');
  const baseName = (dot > 0 ? itemName.substring(0, dot) : itemName) || itemName;
  let candidate = `${baseName}.${targetFormat}`;
  let counter = 1;
  while (used.has(candidate)) {
    candidate = `${baseName}_(${counter}).${targetFormat}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

export function useClientQueue(options?: UseClientQueueOptions) {
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  const handleFilesSelected = (files: File[], overrideTarget?: string) => {
    const maxLimit = getEffectiveMaxFileSize();
    const effectiveDefault = overrideTarget || options?.defaultTarget;
    const newItems: ConversionQueueItem[] = files.map((file) => {
      const detected = detectFormatFromFilename(file.name);
      const ext = detected ? detected.extension : file.name.split('.').pop() || 'bin';
      const sourceFormat = ext.toLowerCase();
      const targetFormat = resolveInitialTargetFormat(sourceFormat, effectiveDefault);
      const isOverSize = file.size > maxLimit;
      return {
        id: createQueueItemId(file.name),
        file,
        name: file.name,
        size: file.size,
        sourceFormat,
        targetFormat,
        status: isOverSize ? 'error' : 'ready',
        error: isOverSize
          ? `File exceeds ${Math.round(maxLimit / (1024 * 1024))} MB real-time conversion limit.`
          : undefined,
        progress: 0,
        options: { ...DEFAULT_ITEM_OPTIONS },
      };
    });
    setQueue((prev) => [...prev, ...newItems]);
  };

  const handleFilesSelectedRef = useRef(handleFilesSelected);
  handleFilesSelectedRef.current = handleFilesSelected;

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
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
      revokeBlobIfNeeded(prev.find((i) => i.id === id)?.resultUrl);
      return prev.filter((i) => i.id !== id);
    });
  };

  const handleClearAll = () => {
    queue.forEach((item) => revokeBlobIfNeeded(item.resultUrl));
    setZipError(null);
    setQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, targetFormat: string) => {
    const cleanTarget = targetFormat.toLowerCase();
    setQueue((prev) =>
      prev.map((item) =>
        item.id !== id || item.targetFormat.toLowerCase() === cleanTarget
          ? item
          : resetItemIfFinished(item, { targetFormat: cleanTarget, options: item.options })
      )
    );
  };

  const handleUpdateAllTargets = (targetFormat: string) => {
    const cleanTarget = targetFormat.toLowerCase();
    setQueue((prev) =>
      prev.map((item) => {
        const isSupported = getAvailableTargetFormats(item.sourceFormat).some(
          (f) => f.id === cleanTarget
        );
        if (!isSupported || item.targetFormat.toLowerCase() === cleanTarget) return item;
        return resetItemIfFinished(item, { targetFormat: cleanTarget, options: item.options });
      })
    );
  };

  const handleUpdateOptions = (id: string, nextOptions: ConversionOptions) => {
    setQueue((prev) =>
      prev.map((item) =>
        item.id === id
          ? resetItemIfFinished(item, { targetFormat: item.targetFormat, options: nextOptions })
          : item
      )
    );
  };

  const convertSingleItem = createItemConverter(setQueue);

  const handleConvertAll = async () => {
    setIsConverting(true);
    for (const item of queue.filter((i) => i.status === 'ready' || i.status === 'error')) {
      await convertSingleItem(item);
    }
    setIsConverting(false);
  };

  const handleDownloadAllZip = async () => {
    const completedItems = queue.filter((i) => i.status === 'completed' && i.resultUrl);
    if (completedItems.length === 0) return;
    setZipError(null);
    try {
      const zip = new JSZip();
      const used = new Set<string>();
      for (const item of completedItems) {
        if (!item.resultUrl) continue;
        const res = await fetch(item.resultUrl);
        zip.file(buildUniqueArchiveName(item.name, item.targetFormat, used), await res.blob());
      }
      const zipUrl = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
      const anchor = document.createElement('a');
      anchor.href = zipUrl;
      anchor.download = `${options?.bundlePrefix || 'easyconvert_bundle'}_${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(zipUrl);
    } catch (err: unknown) {
      setZipError(`Could not build ZIP archive. ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  return {
    queue,
    setQueue,
    isConverting,
    zipError,
    clearZipError: () => setZipError(null),
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
