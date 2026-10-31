'use client';

import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
import { executeItemConversion, getEffectiveMaxFileSize } from '@/lib/client-converter';
import { DEFAULT_OPTIONS } from '@/components/workbench/options/options-capabilities';

declare global {
  interface Window {
    __addTestFile?: (name: string, target?: string) => void;
  }
}

interface UseClientQueueOptions {
  defaultTarget?: string;
  bundlePrefix?: string;
}

const ZIP_REVOKE_DELAY_MS = 60_000;

function createQueueItemId(fileName: string): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `item-${Date.now()}-${fileName}`;
}

function resolveInitialTargetFormat(sourceFormat: string, effectiveDefault?: string): string {
  if (!effectiveDefault || effectiveDefault.toLowerCase() === 'any') return '';
  const cleanTarget = effectiveDefault.toLowerCase();
  const normalizedSource = sourceFormat.toLowerCase();
  if (!FORMAT_REGISTRY[normalizedSource]) {
    return FORMAT_REGISTRY[cleanTarget]?.available === false ? '' : cleanTarget;
  }
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

function patchIdleItem(
  item: ConversionQueueItem,
  patch: Pick<ConversionQueueItem, 'targetFormat' | 'options'>,
  maxLimit: number
): ConversionQueueItem {
  if (!canResetToReady(item, maxLimit)) return { ...item, ...patch };
  return {
    id: item.id,
    file: item.file,
    name: item.name,
    size: item.size,
    sourceFormat: item.sourceFormat,
    ...patch,
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

function buildQueuedFileItem(file: File, maxLimit: number, effectiveDefault?: string): ConversionQueueItem {
  const detected = detectFormatFromFilename(file.name);
  const ext = detected?.extension ?? (file.name.split('.').pop() || 'bin');
  const sourceFormat = ext.toLowerCase();
  const isOverSize = file.size > maxLimit;
  const limitMb = Math.round(maxLimit / (1024 * 1024));
  return {
    id: createQueueItemId(file.name),
    file,
    name: file.name,
    size: file.size,
    sourceFormat,
    targetFormat: resolveInitialTargetFormat(sourceFormat, effectiveDefault),
    status: isOverSize ? 'error' : 'ready',
    error: isOverSize ? `File exceeds the ${limitMb} MB real-time conversion limit.` : undefined,
    progress: 0,
    options: { ...DEFAULT_OPTIONS },
  };
}

async function downloadCompletedBundle(items: ConversionQueueItem[], prefix: string): Promise<string> {
  const resolvedEntries = await Promise.all(
    items
      .filter((item): item is ConversionQueueItem & { resultUrl: string } => Boolean(item.resultUrl))
      .map(async (item) => {
        const res = await fetch(item.resultUrl);
        return { item, blob: await res.blob() };
      })
  );
  const zip = new JSZip();
  const used = new Set<string>();
  for (const { item, blob } of resolvedEntries) {
    zip.file(buildUniqueArchiveName(item.name, item.targetFormat, used), blob);
  }
  const zipUrl = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
  const anchor = document.createElement('a');
  anchor.href = zipUrl;
  anchor.download = `${prefix}_${Date.now()}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return zipUrl;
}

function clearTimersAndBlobs(
  timers: Set<ReturnType<typeof setTimeout>>,
  urls: Set<string>
): void {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers.clear();
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
  urls.clear();
}

function useQueueLifecycleEffects(
  mountedRef: React.MutableRefObject<boolean>,
  blobUrlsRef: React.MutableRefObject<Set<string>>,
  timersRef: React.MutableRefObject<Set<ReturnType<typeof setTimeout>>>,
  handleFilesSelectedRef: React.MutableRefObject<(files: File[], overrideTarget?: string) => void>
): void {
  useEffect(() => {
    mountedRef.current = true;
    const urls = blobUrlsRef.current;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      clearTimersAndBlobs(timers, urls);
    };
  }, [mountedRef, blobUrlsRef, timersRef]);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    window.__addTestFile = (name: string, target?: string) => {
      handleFilesSelectedRef.current([new File(['mock test data content'], name, { type: 'application/pdf' })], target);
    };
    return () => {
      delete window.__addTestFile;
    };
  }, [handleFilesSelectedRef]);
}

interface QueueMutationContext {
  bundlePrefix?: string;
  mountedRef: React.MutableRefObject<boolean>;
  queueRef: React.MutableRefObject<ConversionQueueItem[]>;
  generationRef: React.MutableRefObject<Map<string, number>>;
  inFlightIdsRef: React.MutableRefObject<Set<string>>;
  blobUrlsRef: React.MutableRefObject<Set<string>>;
  timersRef: React.MutableRefObject<Set<ReturnType<typeof setTimeout>>>;
  batchGenRef: React.MutableRefObject<number>;
  updateQueue: React.Dispatch<React.SetStateAction<ConversionQueueItem[]>>;
  revokeBlobUrl: (url?: string) => void;
  isItemBusy: (item: ConversionQueueItem) => boolean;
  syncInFlight: () => void;
  setIsBatchRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setInFlightCount: React.Dispatch<React.SetStateAction<number>>;
  setZipError: React.Dispatch<React.SetStateAction<string | null>>;
}

function createQueueMutators(ctx: QueueMutationContext) {
  const mutateIdleItems = (
    predicate: (item: ConversionQueueItem) => boolean,
    getPatch: (item: ConversionQueueItem) => Pick<ConversionQueueItem, 'targetFormat' | 'options'>
  ) => {
    const maxLimit = getEffectiveMaxFileSize();
    const matches = ctx.queueRef.current.filter((item) => !ctx.isItemBusy(item) && predicate(item));
    if (matches.length === 0) return;
    for (const item of matches) {
      if (canResetToReady(item, maxLimit)) {
        ctx.revokeBlobUrl(item.resultUrl);
      }
    }
    ctx.updateQueue((prev) =>
      prev.map((item) => (!ctx.isItemBusy(item) && predicate(item) ? patchIdleItem(item, getPatch(item), maxLimit) : item))
    );
  };

  const handleRemoveItem = (id: string) => {
    ctx.revokeBlobUrl(ctx.queueRef.current.find((i) => i.id === id)?.resultUrl);
    ctx.generationRef.current.set(id, (ctx.generationRef.current.get(id) ?? 0) + 1);
    ctx.inFlightIdsRef.current.delete(id);
    ctx.syncInFlight();
    ctx.updateQueue((prev) => prev.filter((i) => i.id !== id));
    if (ctx.queueRef.current.length === 0) {
      ctx.batchGenRef.current += 1;
      ctx.setIsBatchRunning(false);
    }
  };

  const handleClearAll = () => {
    for (const item of ctx.queueRef.current) {
      ctx.revokeBlobUrl(item.resultUrl);
      ctx.generationRef.current.set(item.id, (ctx.generationRef.current.get(item.id) ?? 0) + 1);
    }
    clearTimersAndBlobs(ctx.timersRef.current, ctx.blobUrlsRef.current);
    ctx.batchGenRef.current += 1;
    ctx.inFlightIdsRef.current.clear();
    ctx.setIsBatchRunning(false);
    ctx.setInFlightCount(0);
    ctx.setZipError(null);
    ctx.updateQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, targetFormat: string) => {
    const clean = targetFormat.toLowerCase();
    mutateIdleItems((i) => i.id === id && i.targetFormat.toLowerCase() !== clean, (i) => ({ targetFormat: clean, options: i.options }));
  };

  const handleUpdateAllTargets = (targetFormat: string) => {
    const clean = targetFormat.toLowerCase();
    mutateIdleItems(
      (i) => i.targetFormat.toLowerCase() !== clean && getAvailableTargetFormats(i.sourceFormat).some((f) => f.id === clean),
      (i) => ({ targetFormat: clean, options: i.options })
    );
  };

  const handleUpdateOptions = (id: string, nextOptions: ConversionOptions) => {
    mutateIdleItems((i) => i.id === id && !shallowEqualOptions(i.options, nextOptions), (i) => ({ targetFormat: i.targetFormat, options: nextOptions }));
  };

  return {
    handleRemoveItem,
    handleClearAll,
    handleUpdateTargetFormat,
    handleUpdateAllTargets,
    handleUpdateOptions,
  };
}

function createDownloadAllZipHandler(ctx: QueueMutationContext) {
  return async () => {
    const done = ctx.queueRef.current.filter((i) => i.status === 'completed' && i.resultUrl);
    if (done.length === 0) return;
    ctx.setZipError(null);
    try {
      const zipUrl = await downloadCompletedBundle(done, ctx.bundlePrefix || 'easyconvert_bundle');
      if (!ctx.mountedRef.current) {
        URL.revokeObjectURL(zipUrl);
        return;
      }
      ctx.blobUrlsRef.current.add(zipUrl);
      const timer = setTimeout(() => {
        ctx.timersRef.current.delete(timer);
        ctx.revokeBlobUrl(zipUrl);
      }, ZIP_REVOKE_DELAY_MS);
      ctx.timersRef.current.add(timer);
    } catch (err: unknown) {
      if (ctx.mountedRef.current) {
        ctx.setZipError(`Could not build ZIP archive. ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  };
}

function createConversionRunners(ctx: QueueMutationContext) {
  const convertSingleItem = async (itemOrId: ConversionQueueItem | string): Promise<void> => {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id;
    const current = ctx.queueRef.current.find((i) => i.id === id);
    if (!current?.targetFormat || current.size > getEffectiveMaxFileSize() || ctx.inFlightIdsRef.current.has(id)) return;
    const gen = (ctx.generationRef.current.get(id) ?? 0) + 1;
    ctx.generationRef.current.set(id, gen);
    ctx.inFlightIdsRef.current.add(id);
    ctx.syncInFlight();
    ctx.revokeBlobUrl(current.resultUrl);
    ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'converting', progress: 15, error: undefined, resultUrl: undefined } : i)));
    const isFresh = () => ctx.mountedRef.current && ctx.generationRef.current.get(id) === gen && ctx.queueRef.current.some((i) => i.id === id);
    try {
      await executeItemConversion(current, {
        onProgress: (progress) => {
          if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id && i.status === 'converting' ? { ...i, progress } : i)));
        },
        onSuccess: (resultUrl, resultSize, edgeProcessed, edgeTier) => {
          if (!isFresh()) { ctx.revokeBlobUrl(resultUrl); return; }
          if (resultUrl.startsWith('blob:')) ctx.blobUrlsRef.current.add(resultUrl);
          ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'completed', progress: 100, resultUrl, resultSize, edgeProcessed, edgeTier } : i)));
        },
        onError: (msg) => {
          if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'error', error: msg, progress: 0 } : i)));
        },
      });
    } finally {
      if (ctx.generationRef.current.get(id) === gen) {
        ctx.inFlightIdsRef.current.delete(id);
        ctx.syncInFlight();
      }
    }
  };

  const handleConvertAll = async () => {
    const maxLimit = getEffectiveMaxFileSize();
    const ids = ctx.queueRef.current.filter((i) => (i.status === 'ready' || i.status === 'error') && Boolean(i.targetFormat) && i.size <= maxLimit).map((i) => i.id);
    if (ids.length === 0) return;
    const batchGen = ctx.batchGenRef.current + 1;
    ctx.batchGenRef.current = batchGen;
    ctx.setIsBatchRunning(true);
    const runNext = async (index: number): Promise<void> => {
      if (index >= ids.length || ctx.batchGenRef.current !== batchGen || !ctx.mountedRef.current) return;
      const id = ids[index];
      const latest = ctx.queueRef.current.find((i) => i.id === id);
      if (latest && !ctx.isItemBusy(latest) && latest.status !== 'completed' && latest.targetFormat && latest.size <= getEffectiveMaxFileSize()) {
        await convertSingleItem(latest);
      }
      await runNext(index + 1);
    };
    try {
      await runNext(0);
    } finally {
      if (ctx.batchGenRef.current === batchGen && ctx.mountedRef.current) ctx.setIsBatchRunning(false);
    }
  };

  return { convertSingleItem, handleConvertAll };
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
  const [inFlightCount, setInFlightCount] = useState(0);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const queueRef = useRef<ConversionQueueItem[]>(queue);
  queueRef.current = queue;
  const generationRef = useRef<Map<string, number>>(new Map());
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const mountedRef = useRef(true);
  const batchGenRef = useRef(0);
  const updateQueue: React.Dispatch<React.SetStateAction<ConversionQueueItem[]>> = (a) => updateQueueState(queueRef, setQueue, a);
  const syncInFlight = () => {
    if (mountedRef.current) setInFlightCount(inFlightIdsRef.current.size);
  };
  const revokeBlobUrl = (url?: string) => {
    if (!url?.startsWith('blob:')) return;
    URL.revokeObjectURL(url);
    blobUrlsRef.current.delete(url);
  };
  const isItemBusy = (i: ConversionQueueItem) =>
    i.status === 'uploading' || i.status === 'converting' || inFlightIdsRef.current.has(i.id);
  const handleFilesSelected = (files: File[], overrideTarget?: string) => {
    const maxLimit = getEffectiveMaxFileSize();
    const def = overrideTarget || options?.defaultTarget;
    updateQueue((prev) => [...prev, ...files.map((f) => buildQueuedFileItem(f, maxLimit, def))]);
  };
  const handleFilesSelectedRef = useRef(handleFilesSelected);
  handleFilesSelectedRef.current = handleFilesSelected;
  useQueueLifecycleEffects(mountedRef, blobUrlsRef, timersRef, handleFilesSelectedRef);

  const mutationCtx: QueueMutationContext = {
    bundlePrefix: options?.bundlePrefix, mountedRef, queueRef, generationRef, inFlightIdsRef,
    blobUrlsRef, timersRef, batchGenRef, updateQueue, revokeBlobUrl, isItemBusy, syncInFlight,
    setIsBatchRunning, setInFlightCount, setZipError,
  };
  const mutators = createQueueMutators(mutationCtx);
  const runners = createConversionRunners(mutationCtx);
  const handleDownloadAllZip = createDownloadAllZipHandler(mutationCtx);

  return {
    queue, setQueue: updateQueue, isConverting: inFlightCount > 0 || isBatchRunning, zipError,
    clearZipError: () => setZipError(null), handleFilesSelected, ...mutators,
    ...runners, handleDownloadAllZip,
  };
}
