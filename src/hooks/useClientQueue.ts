'use client';

import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
import { executeItemConversion, getEffectiveMaxFileSize } from '@/lib/client-converter';

declare global {
  interface Window { __addTestFile?: (name: string, target?: string) => void; }
}

interface UseClientQueueOptions { defaultTarget?: string; bundlePrefix?: string; }

const DEFAULT_ITEM_OPTIONS: ConversionOptions = {
  quality: 85, fit: 'contain', stripMetadata: false, orientation: 'portrait', compressionLevel: 6,
};

function createQueueItemId(fileName: string): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `item-${Date.now()}-${fileName}`;
}

function resolveInitialTargetFormat(sourceFormat: string, effectiveDefault?: string): string {
  if (!effectiveDefault || effectiveDefault.toLowerCase() === 'any') return '';
  const cleanTarget = effectiveDefault.toLowerCase();
  const normalizedSource = sourceFormat.toLowerCase();
  if (!FORMAT_REGISTRY[normalizedSource]) return FORMAT_REGISTRY[cleanTarget]?.available === false ? '' : cleanTarget;
  return getAvailableTargetFormats(normalizedSource).some((f) => f.id === cleanTarget) ? cleanTarget : '';
}

function shallowEqualOptions(a: ConversionOptions, b: ConversionOptions): boolean {
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(recA), ...Object.keys(recB)])) {
    if (!Object.is(recA[key], recB[key])) return false;
  }
  return true;
}

function canResetToReady(item: ConversionQueueItem, maxLimit: number): boolean {
  return item.status === 'completed' || (item.status === 'error' && item.size <= maxLimit);
}

function patchIdleItem(item: ConversionQueueItem, patch: Pick<ConversionQueueItem, 'targetFormat' | 'options'>, maxLimit: number): ConversionQueueItem {
  if (!canResetToReady(item, maxLimit)) return { ...item, ...patch };
  return { id: item.id, file: item.file, name: item.name, size: item.size, sourceFormat: item.sourceFormat, ...patch, status: 'ready', progress: 0 };
}

function buildUniqueArchiveName(itemName: string, targetFormat: string, used: Set<string>): string {
  const dot = itemName.lastIndexOf('.');
  const baseName = (dot > 0 ? itemName.substring(0, dot) : itemName) || itemName;
  let candidate = `${baseName}.${targetFormat}`;
  for (let counter = 1; used.has(candidate); counter += 1) candidate = `${baseName}_(${counter}).${targetFormat}`;
  used.add(candidate);
  return candidate;
}

function buildQueuedFileItem(file: File, maxLimit: number, effectiveDefault?: string): ConversionQueueItem {
  const detected = detectFormatFromFilename(file.name);
  const ext = detected ? detected.extension : file.name.split('.').pop() || 'bin';
  const sourceFormat = ext.toLowerCase();
  const isOverSize = file.size > maxLimit;
  const limitMb = Math.round(maxLimit / (1024 * 1024));
  return {
    id: createQueueItemId(file.name), file, name: file.name, size: file.size, sourceFormat,
    targetFormat: resolveInitialTargetFormat(sourceFormat, effectiveDefault),
    status: isOverSize ? 'error' : 'ready',
    error: isOverSize ? `File exceeds the ${limitMb} MB real-time conversion limit.` : undefined,
    progress: 0, options: { ...DEFAULT_ITEM_OPTIONS },
  };
}

async function downloadCompletedBundle(items: ConversionQueueItem[], prefix: string): Promise<void> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const item of items) {
    if (!item.resultUrl) continue;
    const res = await fetch(item.resultUrl);
    zip.file(buildUniqueArchiveName(item.name, item.targetFormat, used), await res.blob());
  }
  const zipUrl = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = zipUrl;
    anchor.download = `${prefix}_${Date.now()}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(zipUrl);
  }
}

const updateQueueState = (
  ref: React.MutableRefObject<ConversionQueueItem[]>,
  setter: React.Dispatch<React.SetStateAction<ConversionQueueItem[]>>,
  action: React.SetStateAction<ConversionQueueItem[]>
) => {
  const next = typeof action === 'function' ? action(ref.current) : action;
  ref.current = next;
  setter(next);
};

export function useClientQueue(options?: UseClientQueueOptions) {
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [activeConversions, setActiveConversions] = useState(0);
  const [zipError, setZipError] = useState<string | null>(null);
  const queueRef = useRef<ConversionQueueItem[]>(queue);
  queueRef.current = queue;
  const generationRef = useRef<Map<string, number>>(new Map());
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const updateQueue: React.Dispatch<React.SetStateAction<ConversionQueueItem[]>> = (a) => updateQueueState(queueRef, setQueue, a);
  const revokeBlobUrl = (url?: string) => {
    if (!url?.startsWith('blob:')) return;
    URL.revokeObjectURL(url);
    blobUrlsRef.current.delete(url);
  };
  const isItemBusy = (i: ConversionQueueItem) => i.status === 'uploading' || i.status === 'converting' || inFlightIdsRef.current.has(i.id);
  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); };
  }, []);
  const handleFilesSelected = (files: File[], overrideTarget?: string) => {
    const maxLimit = getEffectiveMaxFileSize();
    const def = overrideTarget || options?.defaultTarget;
    updateQueue((prev) => [...prev, ...files.map((f) => buildQueuedFileItem(f, maxLimit, def))]);
  };
  const handleFilesSelectedRef = useRef(handleFilesSelected);
  handleFilesSelectedRef.current = handleFilesSelected;
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    window.__addTestFile = (name: string, target?: string) => {
      handleFilesSelectedRef.current([new File(['mock test data content'], name, { type: 'application/pdf' })], target);
    };
    return () => { delete window.__addTestFile; };
  }, []);

  const mutateIdleItems = (
    predicate: (item: ConversionQueueItem) => boolean,
    getPatch: (item: ConversionQueueItem) => Pick<ConversionQueueItem, 'targetFormat' | 'options'>
  ) => {
    const maxLimit = getEffectiveMaxFileSize();
    const matches = queueRef.current.filter((item) => !isItemBusy(item) && predicate(item));
    if (matches.length === 0) return;
    for (const item of matches) {
      if (canResetToReady(item, maxLimit)) revokeBlobUrl(item.resultUrl);
    }
    updateQueue((prev) => prev.map((item) => (!isItemBusy(item) && predicate(item) ? patchIdleItem(item, getPatch(item), maxLimit) : item)));
  };

  const handleRemoveItem = (id: string) => {
    revokeBlobUrl(queueRef.current.find((i) => i.id === id)?.resultUrl);
    generationRef.current.set(id, (generationRef.current.get(id) ?? 0) + 1);
    updateQueue((prev) => prev.filter((i) => i.id !== id));
  };

  const handleClearAll = () => {
    for (const item of queueRef.current) {
      revokeBlobUrl(item.resultUrl);
      generationRef.current.set(item.id, (generationRef.current.get(item.id) ?? 0) + 1);
    }
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current.clear();
    setZipError(null);
    updateQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, targetFormat: string) => {
    const clean = targetFormat.toLowerCase();
    mutateIdleItems((i) => i.id === id && i.targetFormat.toLowerCase() !== clean, (i) => ({ targetFormat: clean, options: i.options }));
  };

  const handleUpdateAllTargets = (targetFormat: string) => {
    const clean = targetFormat.toLowerCase();
    mutateIdleItems((i) => i.targetFormat.toLowerCase() !== clean && getAvailableTargetFormats(i.sourceFormat).some((f) => f.id === clean), (i) => ({ targetFormat: clean, options: i.options }));
  };

  const handleUpdateOptions = (id: string, nextOptions: ConversionOptions) => {
    mutateIdleItems((i) => i.id === id && !shallowEqualOptions(i.options, nextOptions), (i) => ({ targetFormat: i.targetFormat, options: nextOptions }));
  };

  const convertSingleItem = async (itemOrId: ConversionQueueItem | string): Promise<void> => {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id;
    const current = queueRef.current.find((i) => i.id === id);
    if (!current || !current.targetFormat || current.size > getEffectiveMaxFileSize() || inFlightIdsRef.current.has(id)) return;
    const gen = (generationRef.current.get(id) ?? 0) + 1;
    generationRef.current.set(id, gen);
    inFlightIdsRef.current.add(id);
    revokeBlobUrl(current.resultUrl);
    setActiveConversions((c) => c + 1);
    updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'converting', progress: 15, error: undefined, resultUrl: undefined } : i)));
    const isFresh = () => generationRef.current.get(id) === gen && queueRef.current.some((i) => i.id === id);
    try {
      await executeItemConversion(current, {
        onProgress: (progress) => { if (isFresh()) updateQueue((prev) => prev.map((i) => (i.id === id && i.status === 'converting' ? { ...i, progress } : i))); },
        onSuccess: (resultUrl, resultSize, edgeProcessed, edgeTier) => {
          if (!isFresh()) return revokeBlobUrl(resultUrl);
          if (resultUrl.startsWith('blob:')) blobUrlsRef.current.add(resultUrl);
          updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'completed', progress: 100, resultUrl, resultSize, edgeProcessed, edgeTier } : i)));
        },
        onError: (msg) => { if (isFresh()) updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'error', error: msg, progress: 0 } : i))); },
      });
    } finally {
      inFlightIdsRef.current.delete(id);
      setActiveConversions((c) => Math.max(0, c - 1));
    }
  };

  const handleConvertAll = async () => {
    const maxLimit = getEffectiveMaxFileSize();
    const ids = queueRef.current.filter((i) => (i.status === 'ready' || i.status === 'error') && Boolean(i.targetFormat) && i.size <= maxLimit).map((i) => i.id);
    if (ids.length === 0) return;
    setActiveConversions((c) => c + 1);
    try {
      for (const id of ids) {
        const latest = queueRef.current.find((i) => i.id === id);
        if (latest && !isItemBusy(latest) && latest.status !== 'completed' && latest.targetFormat && latest.size <= getEffectiveMaxFileSize()) {
          await convertSingleItem(latest);
        }
      }
    } finally {
      setActiveConversions((c) => Math.max(0, c - 1));
    }
  };
  const handleDownloadAllZip = async () => {
    const done = queueRef.current.filter((i) => i.status === 'completed' && i.resultUrl);
    if (done.length === 0) return;
    setZipError(null);
    try {
      await downloadCompletedBundle(done, options?.bundlePrefix || 'easyconvert_bundle');
    } catch (err: unknown) {
      setZipError(`Could not build ZIP archive. ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };
  return {
    queue, setQueue: updateQueue, isConverting: activeConversions > 0, zipError,
    clearZipError: () => setZipError(null), handleFilesSelected, handleRemoveItem, handleClearAll,
    handleUpdateTargetFormat, handleUpdateAllTargets, handleUpdateOptions,
    convertSingleItem, handleConvertAll, handleDownloadAllZip,
  };
}
