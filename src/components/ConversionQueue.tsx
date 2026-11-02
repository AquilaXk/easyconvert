'use client';

import React, { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, ChevronDown, Loader2, Package, Trash2, X } from 'lucide-react';
import { ConversionQueueItem, ConversionOptions, FormatDefinition } from '@/lib/types';
import { getAvailableTargetFormats } from '@/lib/registry';
import { maxFileBytes } from '@/lib/plan-limits';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import FormatSelector from './FormatSelector';
import OptionsModal from './OptionsModal';
import AdBanner from './AdBanner';
import QueueItemRow from './workbench/QueueItemRow';
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
    <div className="px-4 sm:px-5 py-3 border-b border-rule flex flex-wrap items-center justify-between gap-3">
      {onUpdateAllTargets && canBatchSelect ? (
        <div className="flex items-center flex-wrap gap-2.5">
          <span className="text-xs font-medium text-ink-2">{t('convertAllTo')}</span>
          <div className="relative">
            <button
              type="button" aria-haspopup="dialog" aria-expanded={isBatchSelectorOpen} disabled={effectiveBusy} onClick={onToggleBatchSelector}
              className="transition-colors inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-xs border border-rule bg-sunken text-sm font-semibold uppercase text-ink hover:border-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>{batchTargetLabel ? batchTargetLabel.toUpperCase() : t('chooseFormat')}</span>
              <ChevronDown className="w-3.5 h-3.5 text-ink-3" />
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
        <span className="text-xs font-medium text-ink-2">{t('filesInQueue', { count: itemCount })}</span>
      )}
      <button
        type="button" disabled={effectiveBusy} onClick={onClearAll}
        className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-sm text-xs font-medium text-ink-2 hover:text-danger hover:bg-danger-soft transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Trash2 className="w-3.5 h-3.5" /><span>{t('clearAll')}</span>
      </button>
    </div>
  );
}

interface QueueFooterBarProps {
  statusSummary: string; zipError?: boolean; onDismissZipError?: () => void;
  effectiveBusy: boolean; completedCount: number; allDone: boolean; canConvert: boolean;
  onAddMoreFiles: () => void; onDownloadAllZip: () => void; onConvertAll: () => void;
}

function QueueFooterBar({
  statusSummary, zipError, onDismissZipError, effectiveBusy, completedCount,
  allDone, canConvert, onAddMoreFiles, onDownloadAllZip, onConvertAll,
}: Readonly<QueueFooterBarProps>) {
  const t = useTranslations('queue');
  const zipFailed = useTranslations('errors.queue')('zipFailed');
  return (
    <div className="bg-surface border-t border-rule px-4 sm:px-5 py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3">
      <div className="min-w-0">
        <output aria-live="polite" className="block text-sm text-ink-2">{statusSummary}</output>
        {zipError && (
          <div className="mt-1 flex items-center gap-2 text-xs text-danger">
            <p role="alert" className="min-w-0">{zipFailed}</p>
            {onDismissZipError && (
              <button
                type="button" aria-label={t('dismissZipError')} onClick={onDismissZipError}
                className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-sm hover:bg-danger-soft cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center flex-wrap sm:flex-nowrap gap-2.5 w-full sm:w-auto justify-end">
        <button
          type="button" disabled={effectiveBusy} onClick={onAddMoreFiles}
          className="transition-colors min-h-[48px] px-4 rounded-xs text-ink border border-rule bg-sunken hover:border-ink-3 text-sm font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span>{t('addMore')}</span>
        </button>
        {completedCount > 1 && (
          <button
            type="button" onClick={onDownloadAllZip}
            className="transition-colors min-h-[48px] px-4 rounded-xs bg-accent-soft text-accent-ink border border-accent-edge hover:border-accent text-sm font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Package className="w-4 h-4" /><span>{t('downloadAll')}</span>
          </button>
        )}
        {!allDone && (
          <button
            type="button" disabled={!canConvert} onClick={onConvertAll}
            className="btn-primary min-h-[48px] px-6 rounded-xs text-lg font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {effectiveBusy ? (
              <><Loader2 className="w-4 h-4 animate-spin" /><span>{t('converting')}</span></>
            ) : (
              <><span>{t('convert')}</span><ArrowRight className="w-4 h-4" /></>
            )}
          </button>
        )}
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
  return { effectiveBusy, completedCount, allDone, canConvert, statusSummary };
}

export default function ConversionQueue({
  items, onRemoveItem, onClearAll, onUpdateTargetFormat, onUpdateAllTargets,
  onUpdateOptions, onConvertAll, onConvertSingle, onAddMoreFiles, onDownloadAllZip,
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
    <>
      <div className="bg-surface/50 w-full rounded-none border border-rule overflow-visible">
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
        <div className="divide-y divide-rule">
          {items.map((item) => (
            <QueueItemRow
              key={item.id} item={item} isFormatSelectorOpen={activeFormatSelectorId === item.id}
              onToggleFormatSelector={() => {
                setIsBatchSelectorOpen(false);
                setActiveFormatSelectorId((prev) => (prev === item.id ? null : item.id));
              }}
              onCloseFormatSelector={() => setActiveFormatSelectorId(null)}
              onSelectTargetFormat={(fmt) => { onUpdateTargetFormat(item.id, fmt); setActiveFormatSelectorId(null); }}
              onOpenOptions={() => setActiveOptionsModalId(item.id)}
              onRetry={() => onConvertSingle(item.id)} onRemove={() => onRemoveItem(item.id)}
            />
          ))}
        </div>
        <QueueFooterBar
          statusSummary={view.statusSummary} zipError={zipError} onDismissZipError={onDismissZipError}
          effectiveBusy={view.effectiveBusy} completedCount={view.completedCount} allDone={view.allDone} canConvert={view.canConvert}
          onAddMoreFiles={onAddMoreFiles} onDownloadAllZip={onDownloadAllZip} onConvertAll={onConvertAll}
        />
      </div>
      {view.completedCount > 0 && <AdBanner slot="post-conversion" className="mt-8" />}
      {currentOptionsItem?.targetFormat && currentOptionsItem.size <= maxLimit && (
        <OptionsModal
          key={`${currentOptionsItem.id}:${currentOptionsItem.sourceFormat}:${currentOptionsItem.targetFormat}`}
          filename={currentOptionsItem.name} sourceFormat={currentOptionsItem.sourceFormat}
          targetFormat={currentOptionsItem.targetFormat} initialOptions={currentOptionsItem.options}
          onSave={(opts) => { onUpdateOptions(currentOptionsItem.id, opts); setActiveOptionsModalId(null); }}
          onClose={() => setActiveOptionsModalId(null)}
        />
      )}
    </>
  );
}
