'use client';

import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
import { executeItemConversion } from '@/lib/client-converter';
import { fileTooLargeMessage, maxFileBytes, type Plan } from '@/lib/plan-limits';
import { getViewerMaxFileBytes, getViewerPlan } from '@/lib/viewer-plan';
import { useViewerPlan } from './useViewerPlan';
import {
  DEFAULT_OPTIONS,
  getPasswordValidationError,
  sanitizeOptionsForPair,
} from '@/components/workbench/options/options-capabilities';

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

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function definedKeys(rec: Record<string, unknown>): string[] {
  return Object.keys(rec).filter((key) => rec[key] !== undefined);
}

function areRecordsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = definedKeys(a);
  const keysB = definedKeys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(b, key) && areValuesEqual(a[key], b[key]));
}

function areValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, idx) => areValuesEqual(item, b[idx]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    return areRecordsEqual(a, b);
  }
  return false;
}

export function areOptionsEqual(a: ConversionOptions, b: ConversionOptions): boolean {
  return areValuesEqual(a, b);
}

function hasValidItemOptions(item: ConversionQueueItem): boolean {
  return getPasswordValidationError(item.sourceFormat, item.targetFormat, item.options.password) === null;
}

type IdleItemPatch = Pick<ConversionQueueItem, 'targetFormat' | 'options'>;

function isConvertiblePendingItem(item: ConversionQueueItem, maxLimit: number): boolean {
  return (
    (item.status === 'ready' || item.status === 'error') &&
    Boolean(item.targetFormat) &&
    item.size <= maxLimit &&
    hasValidItemOptions(item)
  );
}

function patchIdleItem(item: ConversionQueueItem, patch: IdleItemPatch): ConversionQueueItem {
  const optionError = getPasswordValidationError(
    item.sourceFormat,
    patch.targetFormat,
    patch.options.password
  );
  const base = {
    id: item.id,
    file: item.file,
    name: item.name,
    size: item.size,
    sourceFormat: item.sourceFormat,
    ...patch,
    progress: 0,
  };
  return optionError !== null
    ? { ...base, status: 'error', error: optionError }
    : { ...base, status: 'ready' };
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

export function buildQueuedFileItem(file: File, plan: Plan, effectiveDefault?: string): ConversionQueueItem {
  const detected = detectFormatFromFilename(file.name);
  const ext = detected?.extension ?? (file.name.split('.').pop() || 'bin');
  const sourceFormat = ext.toLowerCase();
  const isOverSize = file.size > maxFileBytes(plan);
  return {
    id: createQueueItemId(file.name),
    file,
    name: file.name,
    size: file.size,
    sourceFormat,
    targetFormat: resolveInitialTargetFormat(sourceFormat, effectiveDefault),
    status: isOverSize ? 'error' : 'ready',
    error: isOverSize ? fileTooLargeMessage(plan, file.size) : undefined,
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

function isRunning(item: ConversionQueueItem): boolean {
  return item.status === 'uploading' || item.status === 'converting';
}

function abortAll(aborters: Map<string, AbortController>): void {
  for (const controller of aborters.values()) controller.abort();
  aborters.clear();
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
  abortersRef: React.MutableRefObject<Map<string, AbortController>>,
  handleFilesSelectedRef: React.MutableRefObject<(files: File[], overrideTarget?: string) => void>,
  handleFilesSelected: (files: File[], overrideTarget?: string) => void
): void {
  useEffect(() => {
    handleFilesSelectedRef.current = handleFilesSelected;
  });

  useEffect(() => {
    mountedRef.current = true;
    const urls = blobUrlsRef.current;
    const timers = timersRef.current;
    const aborters = abortersRef.current;
    return () => {
      mountedRef.current = false;
      abortAll(aborters);
      clearTimersAndBlobs(timers, urls);
    };
  }, [mountedRef, blobUrlsRef, timersRef, abortersRef]);

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

export interface QueueMutationContext {
  bundlePrefix?: string;
  mountedRef: React.MutableRefObject<boolean>;
  queueRef: React.MutableRefObject<ConversionQueueItem[]>;
  generationRef: React.MutableRefObject<Map<string, number>>;
  inFlightIdsRef: React.MutableRefObject<Set<string>>;
  /** The cancellation of each running conversion: removing the item ends its upload and cancels its job. */
  abortersRef: React.MutableRefObject<Map<string, AbortController>>;
  blobUrlsRef: React.MutableRefObject<Set<string>>;
  timersRef: React.MutableRefObject<Set<ReturnType<typeof setTimeout>>>;
  batchGenRef: React.MutableRefObject<number>;
  batchRunningRef: React.MutableRefObject<boolean>;
  updateQueue: React.Dispatch<React.SetStateAction<ConversionQueueItem[]>>;
  revokeBlobUrl: (url?: string) => void;
  isItemBusy: (item: ConversionQueueItem) => boolean;
  syncInFlight: () => void;
  setIsBatchRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setInFlightCount: React.Dispatch<React.SetStateAction<number>>;
  setZipError: React.Dispatch<React.SetStateAction<string | null>>;
}

export function createQueueMutators(ctx: QueueMutationContext) {
  const mutateIdleItems = (
    predicate: (item: ConversionQueueItem) => boolean,
    getPatch: (item: ConversionQueueItem) => IdleItemPatch
  ) => {
    const maxLimit = getViewerMaxFileBytes();
    const canEdit = (item: ConversionQueueItem) =>
      !ctx.isItemBusy(item) && item.size <= maxLimit && predicate(item);
    const matches = ctx.queueRef.current.filter(canEdit);
    if (matches.length === 0) return;
    for (const item of matches) {
      ctx.revokeBlobUrl(item.resultUrl);
    }
    ctx.updateQueue((prev) =>
      prev.map((item) => (canEdit(item) ? patchIdleItem(item, getPatch(item)) : item))
    );
  };

  const handleRemoveItem = (id: string) => {
    ctx.revokeBlobUrl(ctx.queueRef.current.find((i) => i.id === id)?.resultUrl);
    ctx.generationRef.current.set(id, (ctx.generationRef.current.get(id) ?? 0) + 1);
    ctx.abortersRef.current.get(id)?.abort();
    ctx.abortersRef.current.delete(id);
    ctx.inFlightIdsRef.current.delete(id);
    ctx.syncInFlight();
    ctx.updateQueue((prev) => prev.filter((i) => i.id !== id));
    const maxLimit = getViewerMaxFileBytes();
    const hasPendingConvertible = ctx.queueRef.current.some((i) =>
      isConvertiblePendingItem(i, maxLimit)
    );
    if (ctx.inFlightIdsRef.current.size === 0 && !hasPendingConvertible) {
      ctx.batchGenRef.current += 1;
      ctx.batchRunningRef.current = false;
      ctx.setIsBatchRunning(false);
    }
  };

  const handleClearAll = () => {
    for (const item of ctx.queueRef.current) {
      ctx.revokeBlobUrl(item.resultUrl);
      ctx.generationRef.current.set(item.id, (ctx.generationRef.current.get(item.id) ?? 0) + 1);
    }
    abortAll(ctx.abortersRef.current);
    clearTimersAndBlobs(ctx.timersRef.current, ctx.blobUrlsRef.current);
    ctx.batchGenRef.current += 1;
    ctx.batchRunningRef.current = false;
    ctx.inFlightIdsRef.current.clear();
    ctx.setIsBatchRunning(false);
    ctx.setInFlightCount(0);
    ctx.setZipError(null);
    ctx.updateQueue([]);
  };

  const handleUpdateTargetFormat = (id: string, targetFormat: string) => {
    const clean = targetFormat.toLowerCase();
    mutateIdleItems(
      (i) => i.id === id && i.targetFormat.toLowerCase() !== clean,
      (i) => ({
        targetFormat: clean,
        options: sanitizeOptionsForPair(i.options, i.sourceFormat, clean),
      })
    );
  };

  const handleUpdateAllTargets = (targetFormat: string) => {
    const clean = targetFormat.toLowerCase();
    mutateIdleItems(
      (i) =>
        i.targetFormat.toLowerCase() !== clean &&
        getAvailableTargetFormats(i.sourceFormat).some((f) => f.id === clean),
      (i) => ({
        targetFormat: clean,
        options: sanitizeOptionsForPair(i.options, i.sourceFormat, clean),
      })
    );
  };

  const handleUpdateOptions = (id: string, nextOptions: ConversionOptions) => {
    mutateIdleItems(
      (i) =>
        i.id === id &&
        !areOptionsEqual(i.options, sanitizeOptionsForPair(nextOptions, i.sourceFormat, i.targetFormat)),
      (i) => ({
        targetFormat: i.targetFormat,
        options: sanitizeOptionsForPair(nextOptions, i.sourceFormat, i.targetFormat),
      })
    );
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

function canConvertBatchTarget(
  item: ConversionQueueItem | undefined,
  ctx: QueueMutationContext
): item is ConversionQueueItem {
  if (!item || ctx.isItemBusy(item) || item.status === 'completed') return false;
  return (
    Boolean(item.targetFormat) &&
    item.size <= getViewerMaxFileBytes() &&
    hasValidItemOptions(item)
  );
}

function failInvalidItemOptions(current: ConversionQueueItem, ctx: QueueMutationContext): boolean {
  const optionError = getPasswordValidationError(
    current.sourceFormat,
    current.targetFormat,
    current.options.password
  );
  if (optionError === null) return false;
  ctx.revokeBlobUrl(current.resultUrl);
  ctx.updateQueue((prev) =>
    prev.map((i) =>
      i.id === current.id
        ? { ...i, status: 'error', error: optionError, progress: 0, resultUrl: undefined }
        : i
    )
  );
  return true;
}

export function createConversionRunners(ctx: QueueMutationContext) {
  const convertSingleItem = async (itemOrId: ConversionQueueItem | string): Promise<void> => {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id;
    const current = ctx.queueRef.current.find((i) => i.id === id);
    if (!current?.targetFormat || current.size > getViewerMaxFileBytes() || ctx.inFlightIdsRef.current.has(id)) return;
    if (failInvalidItemOptions(current, ctx)) return;
    const gen = (ctx.generationRef.current.get(id) ?? 0) + 1;
    ctx.generationRef.current.set(id, gen);
    ctx.inFlightIdsRef.current.add(id);
    const aborter = new AbortController();
    ctx.abortersRef.current.set(id, aborter);
    ctx.syncInFlight();
    ctx.revokeBlobUrl(current.resultUrl);
    ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'converting', progress: 15, error: undefined, resultUrl: undefined } : i)));
    const isFresh = () => ctx.mountedRef.current && ctx.generationRef.current.get(id) === gen && ctx.queueRef.current.some((i) => i.id === id);
    const setStage = (status: 'uploading' | 'converting') => {
      if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id && isRunning(i) ? { ...i, status } : i)));
    };
    try {
      await executeItemConversion(current, {
        onProgress: (progress) => {
          if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id && isRunning(i) ? { ...i, progress } : i)));
        },
        onStage: setStage,
        onSuccess: (resultUrl, resultSize, edgeProcessed, edgeTier) => {
          if (!isFresh()) { ctx.revokeBlobUrl(resultUrl); return; }
          if (resultUrl.startsWith('blob:')) ctx.blobUrlsRef.current.add(resultUrl);
          ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'completed', progress: 100, resultUrl, resultSize, edgeProcessed, edgeTier } : i)));
        },
        onError: (msg) => {
          if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'error', error: msg, progress: 0 } : i)));
        },
      }, aborter.signal);
    } finally {
      if (ctx.generationRef.current.get(id) === gen) {
        ctx.abortersRef.current.delete(id);
        ctx.inFlightIdsRef.current.delete(id);
        ctx.syncInFlight();
      }
    }
  };

  const runBatchFrom = async (
    index: number,
    ids: readonly string[],
    batchGen: number
  ): Promise<void> => {
    if (index >= ids.length || ctx.batchGenRef.current !== batchGen || !ctx.mountedRef.current) return;
    const latest = ctx.queueRef.current.find((i) => i.id === ids[index]);
    if (canConvertBatchTarget(latest, ctx)) {
      await convertSingleItem(latest);
    }
    await runBatchFrom(index + 1, ids, batchGen);
  };

  const handleConvertAll = async () => {
    if (ctx.batchRunningRef.current) return;
    const maxLimit = getViewerMaxFileBytes();
    const ids = ctx.queueRef.current
      .filter((i) => isConvertiblePendingItem(i, maxLimit))
      .map((i) => i.id);
    if (ids.length === 0) return;
    const batchGen = ctx.batchGenRef.current + 1;
    ctx.batchGenRef.current = batchGen;
    ctx.batchRunningRef.current = true;
    ctx.setIsBatchRunning(true);
    try {
      await runBatchFrom(0, ids, batchGen);
    } finally {
      if (ctx.batchGenRef.current === batchGen) {
        ctx.batchRunningRef.current = false;
        if (ctx.mountedRef.current) ctx.setIsBatchRunning(false);
      }
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
  useViewerPlan();
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [inFlightCount, setInFlightCount] = useState(0);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const queueRef = useRef<ConversionQueueItem[]>(queue);
  const generationRef = useRef<Map<string, number>>(new Map());
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const abortersRef = useRef<Map<string, AbortController>>(new Map());
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const mountedRef = useRef(true);
  const batchGenRef = useRef(0);
  const batchRunningRef = useRef(false);
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
    isRunning(i) || inFlightIdsRef.current.has(i.id);
  const handleFilesSelected = (files: File[], overrideTarget?: string) => {
    const plan = getViewerPlan();
    const def = overrideTarget || options?.defaultTarget;
    updateQueue((prev) => [...prev, ...files.map((f) => buildQueuedFileItem(f, plan, def))]);
  };
  const handleFilesSelectedRef = useRef(handleFilesSelected);
  useQueueLifecycleEffects(mountedRef, blobUrlsRef, timersRef, abortersRef, handleFilesSelectedRef, handleFilesSelected);

  const mutationCtx: QueueMutationContext = {
    bundlePrefix: options?.bundlePrefix, mountedRef, queueRef, generationRef, inFlightIdsRef, abortersRef,
    blobUrlsRef, timersRef, batchGenRef, batchRunningRef, updateQueue, revokeBlobUrl, isItemBusy,
    syncInFlight, setIsBatchRunning, setInFlightCount, setZipError,
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
