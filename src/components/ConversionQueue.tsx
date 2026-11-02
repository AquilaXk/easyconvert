'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, CircleCheck, Loader2, Package, Trash2, X } from 'lucide-react';
import { ConversionQueueItem, ConversionOptions, FormatDefinition } from '@/lib/types';
import { getAvailableTargetFormats } from '@/lib/registry';
import { maxFileBytes } from '@/lib/plan-limits';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import FormatSelector from './FormatSelector';
import OptionsModal from './OptionsModal';
import QueueItemRow from './workbench/QueueItemRow';
import FileSourceButton from './workbench/FileSourceButton';
import { getPasswordValidationError } from './workbench/options/options-capabilities';

export interface ConversionQueueProps {
  items: ConversionQueueItem[];
  onRemoveItem: (id: string) => void;
  onClearAll: () => void;
  onUpdateTargetFormat: (id: string, targetFormat: string) => void;
  onUpdateAllTargets?: (targetFormat: string) => void;
  onUpdateOptions: (id: string, options: ConversionOptions) => void;
  onConvertAll: () => void;
  onConvertSingle: (id: string) => void;
  onAddMoreFiles: () => void;
  /** Receives a file the file bar imported from a link. */
  onImportFile: (file: File) => void;
  onDownloadAllZip: () => void;
  isConverting: boolean;
  zipError?: boolean;
  onDismissZipError?: () => void;
}

type QueueTranslator = ReturnType<typeof useTranslations<'queue'>>;

function hasItemOptionError(item: ConversionQueueItem): boolean {
  if (
    !item.targetFormat ||
    item.status === 'completed' ||
    item.status === 'uploading' ||
    item.status === 'converting'
  ) {
    return false;
  }
  return getPasswordValidationError(item.sourceFormat, item.targetFormat, item.options.password) !== null;
}

function getQueueStatusSummary(
  t: QueueTranslator,
  items: ConversionQueueItem[],
  convertibleItems: ConversionQueueItem[],
  isBusy: boolean
): string {
  if (isBusy) return t('status.converting');
  if (convertibleItems.length === 0) {
    if (items.length === 0) return t('status.empty');
    return t('status.oversize', { count: items.length });
  }
  if (convertibleItems.some((i) => !i.targetFormat?.trim())) return t('status.chooseFormat');
  if (convertibleItems.some(hasItemOptionError)) return t('status.fixOptions');
  if (convertibleItems.every((i) => i.status === 'completed')) {
    return t('status.complete', { count: convertibleItems.length });
  }
  const errorCount = convertibleItems.filter((i) => i.status === 'error').length;
  if (errorCount > 0) return t('status.failed', { count: errorCount });
  const readyCount = convertibleItems.filter((i) => i.status === 'ready').length;
  return t('status.ready', { count: readyCount });
}

function collectBatchTargetFormats(items: ConversionQueueItem[]): FormatDefinition[] {
  const seen = new Map<string, FormatDefinition>();
  for (const item of items) {
    for (const fmt of getAvailableTargetFormats(item.sourceFormat)) {
      if (!seen.has(fmt.id)) seen.set(fmt.id, fmt);
    }
  }
  return Array.from(seen.values());
}

interface QueueBatchHeaderProps {
  itemCount: number; canBatchSelect: boolean; effectiveBusy: boolean; isBatchSelectorOpen: boolean; batchTargetLabel: string;
  batchAvailableFormats: FormatDefinition[]; onUpdateAllTargets?: (targetFormat: string) => void;
  onToggleBatchSelector: () => void; onCloseBatchSelector: () => void;
  onSelectBatchTarget: (fmt: string) => void; onClearAll: () => void;
}

function QueueBatchHeader({
  itemCount, canBatchSelect, effectiveBusy, isBatchSelectorOpen, batchTargetLabel, batchAvailableFormats,
  onUpdateAllTargets, onToggleBatchSelector, onCloseBatchSelector, onSelectBatchTarget, onClearAll,
}: Readonly<QueueBatchHeaderProps>) {
  const t = useTranslations('queue');
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      {onUpdateAllTargets && canBatchSelect ? (
        <div className="flex items-center flex-wrap gap-2.5">
          <span className="text-sm font-medium text-ink-2">{t('convertAllTo')}</span>
          <div className="relative">
            <button
              type="button" aria-haspopup="dialog" aria-expanded={isBatchSelectorOpen} disabled={effectiveBusy} onClick={onToggleBatchSelector}
              className="transition-colors inline-flex items-center justify-between gap-2 min-w-32 min-h-[44px] md:min-h-9 px-2.5 rounded-xs border border-rule bg-surface text-sm text-ink hover:border-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>{batchTargetLabel ? batchTargetLabel.toUpperCase() : t('chooseFormat')}</span>
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
            </button>
            {isBatchSelectorOpen && (
              <FormatSelector
                availableFormats={batchAvailableFormats} selectedFormatId={batchTargetLabel}
                onSelect={onSelectBatchTarget} onClose={onCloseBatchSelector} title={t('convertAllTitle')}
              />
            )}
          </div>
        </div>
      ) : (
        <span className="text-sm font-medium text-ink-2">{t('filesInQueue', { count: itemCount })}</span>
      )}
      <button
        type="button" disabled={effectiveBusy} onClick={onClearAll}
        className="inline-flex items-center gap-1.5 min-h-[44px] md:min-h-9 px-3 rounded-xs text-sm font-medium text-ink-2 hover:text-danger hover:bg-danger-soft transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Trash2 aria-hidden="true" className="size-4" /><span>{t('clearAll')}</span>
      </button>
    </div>
  );
}

interface QueueFileBarProps {
  statusSummary: string; zipError?: boolean; onDismissZipError?: () => void;
  effectiveBusy: boolean; completedCount: number; allDone: boolean; canConvert: boolean; isSettledWell: boolean;
  onAddMoreFiles: () => void; onImportFile: (file: File) => void; onDownloadAllZip: () => void; onConvertAll: () => void;
}

/** Publishes the height of `ref`'s element as the root property `property` while it is mounted, as it changes. */
function usePublishedHeight(ref: React.RefObject<HTMLElement | null>, property: string) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty(property, `${element.offsetHeight}px`));
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(property);
    };
  }, [ref, property]);
}

/** The bar pinned to the bottom of the viewport while the queue is on screen: the status, add more files, and convert. */
function QueueFileBar({
  statusSummary, zipError, onDismissZipError, effectiveBusy, completedCount,
  allDone, canConvert, isSettledWell, onAddMoreFiles, onImportFile, onDownloadAllZip, onConvertAll,
}: Readonly<QueueFileBarProps>) {
  const t = useTranslations('queue');
  const zipFailed = useTranslations('errors.queue')('zipFailed');
  const barRef = useRef<HTMLDivElement>(null);
  usePublishedHeight(barRef, '--queue-bar-height');
  return (
    <div ref={barRef} data-queue-bar className="sticky bottom-0 z-30 border-t border-rule bg-surface">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col md:flex-row md:items-center gap-3">
        <div className="min-w-0 md:flex-1 flex flex-col items-center md:items-start">
          <p className="flex items-center gap-2 text-sm text-ink-3">
            {isSettledWell && <CircleCheck aria-hidden="true" className="size-4 shrink-0" />}
            <output aria-live="polite">{statusSummary}</output>
          </p>
          {zipError && (
            <div className="mt-1 flex items-center gap-2 text-xs text-danger">
              <p role="alert" className="min-w-0">{zipFailed}</p>
              {onDismissZipError && (
                <button
                  type="button" aria-label={t('dismissZipError')} onClick={onDismissZipError}
                  className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-xs hover:bg-danger-soft cursor-pointer"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col md:flex-row md:items-center gap-2.5">
          <FileSourceButton
            variant="secondary"
            label={t('addMore')}
            disabled={effectiveBusy}
            onPickDevice={onAddMoreFiles}
            onImportFile={onImportFile}
          />
          {completedCount > 1 && (
            <button
              type="button" onClick={onDownloadAllZip}
              className="transition-colors min-h-[44px] md:min-h-[40px] px-3.5 rounded-xs bg-accent-soft text-accent-ink border border-accent-edge hover:border-accent text-sm font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Package aria-hidden="true" className="size-4" /><span>{t('downloadAll')}</span>
            </button>
          )}
          {!allDone && (
            <button
              type="button" disabled={!canConvert} onClick={onConvertAll}
              className="btn-primary min-h-[48px] px-6 rounded-xs text-lg font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {effectiveBusy ? (
                <><Loader2 aria-hidden="true" className="size-4 animate-spin" /><span>{t('converting')}</span></>
              ) : (
                <span>{t('convert')}</span>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function deriveQueueViewState(
  t: QueueTranslator,
  items: ConversionQueueItem[],
  convertibleItems: ConversionQueueItem[],
  isConverting: boolean
) {
  const effectiveBusy =
    isConverting || items.some((i) => i.status === 'uploading' || i.status === 'converting');
  const completedCount = items.filter((i) => i.status === 'completed').length;
  const allDone =
    convertibleItems.length > 0 && convertibleItems.every((i) => i.status === 'completed');
  const allHaveTarget =
    convertibleItems.length > 0 && convertibleItems.every((i) => Boolean(i.targetFormat?.trim()));
  const hasPending = convertibleItems.some((i) => i.status === 'ready' || i.status === 'error');
  const hasInvalidOptions = convertibleItems.some(hasItemOptionError);
  const canConvert = !effectiveBusy && allHaveTarget && hasPending && !hasInvalidOptions;
  const statusSummary = getQueueStatusSummary(t, items, convertibleItems, effectiveBusy);
  // The check mark of page B's bar stands for "ready" or "done", never beside a failure.
  const isSettledWell = allDone || (canConvert && !convertibleItems.some((i) => i.status === 'error'));
  return { effectiveBusy, completedCount, allDone, canConvert, isSettledWell, statusSummary };
}

/**
 * The queue after files are picked, in the reference layout: one full-width row per file, then a bar that stays at the
 * bottom of the viewport. The section fills the viewport, so the bar starts pinned and settles under the last row at the end.
 */
export default function ConversionQueue({
  items, onRemoveItem, onClearAll, onUpdateTargetFormat, onUpdateAllTargets,
  onUpdateOptions, onConvertAll, onConvertSingle, onAddMoreFiles, onImportFile, onDownloadAllZip,
  isConverting, zipError, onDismissZipError,
}: Readonly<ConversionQueueProps>) {
  const t = useTranslations('queue');
  const [activeFormatSelectorId, setActiveFormatSelectorId] = useState<string | null>(null);
  const [isBatchSelectorOpen, setIsBatchSelectorOpen] = useState(false);
  const [batchTargetLabel, setBatchTargetLabel] = useState<string>('');
  const [activeOptionsModalId, setActiveOptionsModalId] = useState<string | null>(null);

  const plan = useViewerPlan();
  const maxLimit = maxFileBytes(plan);
  const convertibleItems = useMemo(
    () => items.filter((item) => item.size <= maxLimit),
    [items, maxLimit]
  );
  const view = deriveQueueViewState(t, items, convertibleItems, isConverting);
  const batchAvailableFormats = useMemo(
    () => collectBatchTargetFormats(convertibleItems),
    [convertibleItems]
  );
  const currentOptionsItem = items.find((i) => i.id === activeOptionsModalId);

  return (
    <section aria-label={t('label')} className="min-h-[calc(100dvh-var(--header-height))] flex flex-col">
      <div className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {items.length > 1 && (
          <QueueBatchHeader
            itemCount={items.length} canBatchSelect={convertibleItems.length > 1} effectiveBusy={view.effectiveBusy} isBatchSelectorOpen={isBatchSelectorOpen}
            batchTargetLabel={batchTargetLabel} batchAvailableFormats={batchAvailableFormats} onUpdateAllTargets={onUpdateAllTargets}
            onToggleBatchSelector={() => { setActiveFormatSelectorId(null); setIsBatchSelectorOpen((prev) => !prev); }}
            onCloseBatchSelector={() => setIsBatchSelectorOpen(false)}
            onSelectBatchTarget={(fmt) => { setBatchTargetLabel(fmt); onUpdateAllTargets?.(fmt); setIsBatchSelectorOpen(false); }}
            onClearAll={onClearAll}
          />
        )}
        <ul className="flex flex-col gap-3.5">
          {items.map((item) => (
            <li key={item.id}>
              <QueueItemRow
                item={item} isFormatSelectorOpen={activeFormatSelectorId === item.id}
                onToggleFormatSelector={() => {
                  setIsBatchSelectorOpen(false);
                  setActiveFormatSelectorId((prev) => (prev === item.id ? null : item.id));
                }}
                onCloseFormatSelector={() => setActiveFormatSelectorId(null)}
                onSelectTargetFormat={(fmt) => { onUpdateTargetFormat(item.id, fmt); setActiveFormatSelectorId(null); }}
                onOpenOptions={() => setActiveOptionsModalId(item.id)}
                onRetry={() => onConvertSingle(item.id)} onRemove={() => onRemoveItem(item.id)}
              />
            </li>
          ))}
        </ul>
      </div>
      <QueueFileBar
        statusSummary={view.statusSummary} zipError={zipError} onDismissZipError={onDismissZipError}
        effectiveBusy={view.effectiveBusy} completedCount={view.completedCount} allDone={view.allDone} canConvert={view.canConvert}
        isSettledWell={view.isSettledWell} onAddMoreFiles={onAddMoreFiles} onImportFile={onImportFile} onDownloadAllZip={onDownloadAllZip} onConvertAll={onConvertAll}
      />
      {currentOptionsItem?.targetFormat && currentOptionsItem.size <= maxLimit && (
        <OptionsModal
          key={`${currentOptionsItem.id}:${currentOptionsItem.sourceFormat}:${currentOptionsItem.targetFormat}`}
          filename={currentOptionsItem.name} sourceFormat={currentOptionsItem.sourceFormat}
          targetFormat={currentOptionsItem.targetFormat} initialOptions={currentOptionsItem.options}
          onSave={(opts) => { onUpdateOptions(currentOptionsItem.id, opts); setActiveOptionsModalId(null); }}
          onClose={() => setActiveOptionsModalId(null)}
        />
      )}
    </section>
  );
}
