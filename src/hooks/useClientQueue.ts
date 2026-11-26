'use client';

import React, { useState, useEffect, useRef } from 'react';
import { streamZipReadable, type StreamingZipEntry } from '@/lib/archive/streaming-zip';
import { materializeZipStreamUrl, triggerAnchorDownload } from '@/lib/download-blob';
import { extractDownloadExtension, sanitizeDownloadLeafFilename } from '@/lib/download-filename';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { detectFormatFromFilename, getAvailableTargetFormats, getFormatByExtension } from '@/lib/registry';
import { executeItemConversion } from '@/lib/client-converter';
import { releaseEdgeResultResources } from '@/lib/edge/pipelines/opfs-streaming-pipeline';
import {
  persistCompletedServerQueue,
  restoreCompletedServerQueue,
  useBeforeUnloadWhileBusy,
} from '@/lib/queue-session-persistence';
import { warnBrowserFailure } from '@/lib/browser-failure';
import { getViewerMaxFileBytes } from '@/lib/viewer-plan';
import type { HeroOperation } from '@/components/hero/useHeroUpload';
import { useRefreshViewerPlan, useViewerPlan } from './useViewerPlan';
import {
  getPasswordValidationError,
  sanitizeOptionsForPair,
  startingOptionsFor,
} from '@/components/workbench/options/options-capabilities';

declare global {
  interface Window {
    __addTestFile?: (name: string, target?: string) => void;
  }
}

interface UseClientQueueOptions {
  bundlePrefix?: string;
  /** What the page does with its files instead of converting them; the files start with the options that operation needs. */
  operation?: HeroOperation;
}

const ZIP_REVOKE_DELAY_MS = 60_000;

function createQueueItemId(fileName: string): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `item-${Date.now()}-${fileName}`;
}

function isSupportedQueueSource(sourceFormat: string): boolean {
  return Boolean(getFormatByExtension(sourceFormat)) && getAvailableTargetFormats(sourceFormat).length > 0;
}

function resolveInitialTargetFormat(sourceFormat: string, effectiveDefault?: string): string {
  if (!effectiveDefault || effectiveDefault.toLowerCase() === 'any') return '';
  const cleanTarget = effectiveDefault.toLowerCase();
  if (!getFormatByExtension(sourceFormat)) {
    return '';
  }
  return getAvailableTargetFormats(sourceFormat).some((f) => f.id === cleanTarget) ? cleanTarget : '';
}

function extractRawExtension(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed.toLowerCase().endsWith('.tar.bz2') && trimmed.length > '.tar.bz2'.length) {
    return 'tar.bz2';
  }
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return '';
  return trimmed.slice(dot + 1).trim().toLowerCase();
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

function isConvertibleFileItem(item: ConversionQueueItem, maxLimit: number): boolean {
  return item.size > 0 && item.size <= maxLimit && isSupportedQueueSource(item.sourceFormat);
}

function isConvertiblePendingItem(item: ConversionQueueItem, maxLimit: number): boolean {
  return (
    (item.status === 'ready' || item.status === 'error') &&
    Boolean(item.targetFormat) &&
    isConvertibleFileItem(item, maxLimit) &&
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
  return optionError !== null ? { ...base, status: 'error' } : { ...base, status: 'ready' };
}

export function buildUniqueArchiveName(itemName: string, targetFormat: string, used: Set<string>, resultFilename?: string): string {
  const cleanResultName = sanitizeDownloadLeafFilename(resultFilename);
  const outExt = (cleanResultName ? extractDownloadExtension(cleanResultName) : undefined) ?? targetFormat;
  const inputExt = extractDownloadExtension(itemName);
  const baseName =
    inputExt && itemName.length > inputExt.length + 1
      ? itemName.slice(0, itemName.length - inputExt.length - 1)
      : itemName;
  const safeBase = sanitizeDownloadLeafFilename(baseName) || 'file';
  let candidate = `${safeBase}.${outExt}`;
  let counter = 1;
  while (used.has(candidate)) {
    candidate = `${safeBase}_(${counter}).${outExt}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** A queue item for a dropped file. Whether it is over the viewer's limit is read when the row renders, since the plan can still change. */
export function buildQueuedFileItem(file: File, effectiveDefault?: string, operation?: HeroOperation): ConversionQueueItem {
  const detected = detectFormatFromFilename(file.name);
  const sourceFormat = detected?.extension.toLowerCase() ?? extractRawExtension(file.name);
  const targetFormat = resolveInitialTargetFormat(sourceFormat, effectiveDefault);
  return {
    id: createQueueItemId(file.name),
    file,
    name: file.name,
    size: file.size,
    sourceFormat,
    targetFormat,
    status: 'ready',
    progress: 0,
    options: startingOptionsFor(operation, sourceFormat, targetFormat),
  };
}

function storedKeyOfResultUrl(url: string): string | null {
  if (!url.startsWith('/api/storage/file/')) return null;
  const raw = url.slice('/api/storage/file/'.length).split('?')[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Thrown when a result can no longer be fetched (expired or deleted): no ZIP is built, and `ids` name the rows to mark failed. */
class ExpiredResultsError extends Error {
  constructor(readonly ids: ReadonlySet<string>) {
    super('unavailable results');
  }
}

async function prepareServerBundleDownload(
  readyItems: ReadonlyArray<ConversionQueueItem & { resultUrl: string }>,
  serverKeys: readonly string[],
  archiveName: string
): Promise<null> {
  const used = new Set<string>();
  const res = await fetch('/api/storage/bundle?prepare=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      archiveName,
      files: readyItems.map((item, idx) => ({
        key: serverKeys[idx]!,
        name: buildUniqueArchiveName(item.name, item.targetFormat, used, item.unchanged ? item.name : item.resultFilename),
      })),
    }),
  });
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { downloadUrl?: unknown } | null;
    if (typeof body?.downloadUrl !== 'string' || body.downloadUrl.length === 0) {
      throw new Error('Bundle download URL missing from server response.');
    }
    triggerAnchorDownload(body.downloadUrl, archiveName);
    return null;
  }

  const errorBody = (await res.json().catch(() => null)) as { error?: unknown; unavailableKeys?: unknown } | null;
  if ((res.status === 404 || res.status === 410) && Array.isArray(errorBody?.unavailableKeys)) {
    const missing = new Set(errorBody.unavailableKeys.filter((k): k is string => typeof k === 'string'));
    const expiredIds = new Set(readyItems.filter((_, idx) => missing.has(serverKeys[idx]!)).map((item) => item.id));
    if (expiredIds.size > 0) {
      throw new ExpiredResultsError(expiredIds);
    }
  }
  throw new Error(
    typeof errorBody?.error === 'string' && errorBody.error ? errorBody.error : `Bundle download failed (${res.status})`
  );
}

async function downloadCompletedBundle(items: ConversionQueueItem[], prefix: string): Promise<string | null> {
  const readyItems = items.filter((item): item is ConversionQueueItem & { resultUrl: string } => Boolean(item.resultUrl));
  const archiveName = `${prefix}_${Date.now()}.zip`;
  const serverKeys = readyItems.map((item) => storedKeyOfResultUrl(item.resultUrl));
  if (readyItems.length > 0 && serverKeys.every((key): key is string => Boolean(key))) {
    return prepareServerBundleDownload(readyItems, serverKeys, archiveName);
  }

  const settled = await Promise.allSettled(
    readyItems.map(async (item) => {
      const res = await fetch(item.resultUrl);
      return { item, res };
    })
  );
  const fetched: Array<{ item: ConversionQueueItem & { resultUrl: string }; res: Response }> = [];
  let firstError: unknown = null;
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') fetched.push(outcome.value);
    else if (firstError === null) firstError = outcome.reason;
  }
  if (firstError !== null) {
    await Promise.all(fetched.map(({ res }) => res.body?.cancel().catch(() => undefined)));
    throw firstError;
  }

  const unavailable = fetched.filter(({ res }) => !res.ok);
  if (unavailable.length > 0) {
    await Promise.all(fetched.map(({ res }) => res.body?.cancel().catch(() => undefined)));
    throw new ExpiredResultsError(new Set(unavailable.map(({ item }) => item.id)));
  }

  const used = new Set<string>();
  let nextYieldIndex = 0;
  async function* generateEntries(): AsyncGenerator<StreamingZipEntry, void, undefined> {
    try {
      for (; nextYieldIndex < fetched.length; nextYieldIndex++) {
        const { item, res } = fetched[nextYieldIndex];
        const name = buildUniqueArchiveName(item.name, item.targetFormat, used, item.unchanged ? item.name : item.resultFilename);
        if (res.body) {
          yield { name, data: res.body };
        } else {
          const blob = await res.blob();
          yield { name, data: blob, size: blob.size };
        }
      }
    } finally {
      for (let i = nextYieldIndex; i < fetched.length; i++) {
        await fetched[i].res.body?.cancel().catch(() => undefined);
      }
    }
  }

  const stream = streamZipReadable(generateEntries());
  const zipUrl = await materializeZipStreamUrl(stream, archiveName);
  return triggerAnchorDownload(zipUrl, archiveName);
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
    void releaseEdgeResultResources(url);
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
  setZipError: React.Dispatch<React.SetStateAction<boolean>>;
}

export function createQueueMutators(ctx: QueueMutationContext) {
  const mutateIdleItems = (
    predicate: (item: ConversionQueueItem) => boolean,
    getPatch: (item: ConversionQueueItem) => IdleItemPatch
  ) => {
    const maxLimit = getViewerMaxFileBytes();
    const canEdit = (item: ConversionQueueItem) =>
      !ctx.isItemBusy(item) && isConvertibleFileItem(item, maxLimit) && predicate(item);
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
    ctx.setZipError(false);
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

function failUnavailableResults(ids: ReadonlySet<string>, ctx: QueueMutationContext): void {
  ctx.updateQueue((prev) =>
    prev.map((i) => (ids.has(i.id) ? { ...i, status: 'error', error: undefined, progress: 0, resultUrl: undefined, resultFilename: undefined } : i))
  );
}

export function createDownloadAllZipHandler(ctx: QueueMutationContext) {
  return async () => {
    const done = ctx.queueRef.current.filter((i) => i.status === 'completed' && i.resultUrl);
    if (done.length === 0) return;
    ctx.setZipError(false);
    try {
      const zipUrl = await downloadCompletedBundle(done, ctx.bundlePrefix || 'easyconvert_bundle');
      if (zipUrl === null) return;
      if (!ctx.mountedRef.current) {
        if (typeof ctx.revokeBlobUrl === 'function') {
          ctx.revokeBlobUrl(zipUrl);
        } else {
          void releaseEdgeResultResources(zipUrl);
          URL.revokeObjectURL(zipUrl);
        }
        return;
      }
      ctx.blobUrlsRef.current.add(zipUrl);
      const timer = setTimeout(() => {
        ctx.timersRef.current.delete(timer);
        ctx.revokeBlobUrl(zipUrl);
      }, ZIP_REVOKE_DELAY_MS);
      ctx.timersRef.current.add(timer);
    } catch (error) {
      warnBrowserFailure('Bundling the converted files into a ZIP failed', error);
      if (ctx.mountedRef.current) {
        ctx.setZipError(true);
        if (error instanceof ExpiredResultsError) failUnavailableResults(error.ids, ctx);
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
    isConvertibleFileItem(item, getViewerMaxFileBytes()) &&
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
        ? { ...i, status: 'error', error: undefined, progress: 0, resultUrl: undefined, resultFilename: undefined }
        : i
    )
  );
  return true;
}

export function createConversionRunners(ctx: QueueMutationContext) {
  const convertSingleItem = async (itemOrId: ConversionQueueItem | string): Promise<void> => {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id;
    const current = ctx.queueRef.current.find((i) => i.id === id);
    if (!current?.targetFormat || !isConvertibleFileItem(current, getViewerMaxFileBytes()) || ctx.inFlightIdsRef.current.has(id)) return;
    if (failInvalidItemOptions(current, ctx)) return;
    const gen = (ctx.generationRef.current.get(id) ?? 0) + 1;
    ctx.generationRef.current.set(id, gen);
    ctx.inFlightIdsRef.current.add(id);
    const aborter = new AbortController();
    ctx.abortersRef.current.set(id, aborter);
    ctx.syncInFlight();
    ctx.revokeBlobUrl(current.resultUrl);
    ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'converting', progress: undefined, error: undefined, resultUrl: undefined, resultFilename: undefined } : i)));
    const isFresh = () => ctx.mountedRef.current && ctx.generationRef.current.get(id) === gen && ctx.queueRef.current.some((i) => i.id === id);
    const setStage = (status: 'uploading' | 'converting') => {
      if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id && isRunning(i) ? { ...i, status, progress: undefined } : i)));
    };
    try {
      let resolvedFilename: string | undefined;
      await executeItemConversion(current, {
        onProgress: (progress) => {
          if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id && isRunning(i) ? { ...i, progress } : i)));
        },
        onStage: setStage,
        onOutputFilename: (filename) => {
          if (isFresh()) resolvedFilename = filename;
        },
        onSuccess: (resultUrl, resultSize, edgeProcessed, edgeTier, _fallback, unchanged) => {
          if (!isFresh()) { ctx.revokeBlobUrl(resultUrl); return; }
          if (resultUrl.startsWith('blob:')) ctx.blobUrlsRef.current.add(resultUrl);
          ctx.updateQueue((prev) =>
            prev.map((i) =>
              i.id === id
                ? { ...i, status: 'completed', progress: 100, resultUrl, resultSize, resultFilename: resolvedFilename, edgeProcessed, edgeTier, unchanged }
                : i
            )
          );
        },
        onError: (failure) => {
          if (isFresh()) ctx.updateQueue((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'error', error: failure, progress: 0 } : i)));
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

  return { handleConvertAll };
}

/** Immediately deletes a server-stored result (`/api/storage/file/...`) when the caller discards a completed queue item. */
export function releaseStoredResultUrl(url?: string): void {
  if (!url?.startsWith('/api/storage/file/') || typeof fetch !== 'function') return;
  void fetch(url, { method: 'DELETE', keepalive: true }).catch(() => undefined);
}

export function useClientQueue(options?: UseClientQueueOptions) {
  useRefreshViewerPlan();
  useViewerPlan();
  const persistScope = options?.bundlePrefix || 'workbench';
  const [queue, setQueue] = useState<ConversionQueueItem[]>([]);
  const [inFlightCount, setInFlightCount] = useState(0);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [zipError, setZipError] = useState(false);
  const queueRef = useRef<ConversionQueueItem[]>(queue);
  const hydratedRef = useRef(false);
  const generationRef = useRef<Map<string, number>>(new Map());
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const abortersRef = useRef<Map<string, AbortController>>(new Map());
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const mountedRef = useRef(true);
  const batchGenRef = useRef(0);
  const batchRunningRef = useRef(false);
  const updateQueue: React.Dispatch<React.SetStateAction<ConversionQueueItem[]>> = (a) => {
    const next = typeof a === 'function' ? a(queueRef.current) : a;
    queueRef.current = next;
    setQueue(next);
    if (hydratedRef.current) persistCompletedServerQueue(next, persistScope);
  };
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const restored = queueRef.current.length === 0 ? restoreCompletedServerQueue(persistScope) : [];
    if (restored.length > 0) { queueRef.current = restored; setQueue(restored); }
  }, [persistScope]);
  useBeforeUnloadWhileBusy(inFlightCount > 0 || isBatchRunning);
  const syncInFlight = () => {
    if (mountedRef.current) setInFlightCount(inFlightIdsRef.current.size);
  };
  const revokeBlobUrl = (url?: string) => {
    if (!url) return;
    if (url.startsWith('blob:')) {
      void releaseEdgeResultResources(url);
      URL.revokeObjectURL(url);
      blobUrlsRef.current.delete(url);
      return;
    }
    releaseStoredResultUrl(url);
  };
  const isItemBusy = (i: ConversionQueueItem) =>
    isRunning(i) || inFlightIdsRef.current.has(i.id);
  const handleFilesSelected = (files: File[], target?: string) => {
    updateQueue((prev) => [...prev, ...files.map((f) => buildQueuedFileItem(f, target, options?.operation))]);
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
    clearZipError: () => setZipError(false), handleFilesSelected, ...mutators,
    ...runners, handleDownloadAllZip,
  };
}
