'use client';

import React, { useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, Loader2, Package, Trash2, X } from 'lucide-react';
import { ConversionQueueItem, ConversionOptions, FormatDefinition } from '@/lib/types';
import { getAvailableTargetFormats } from '@/lib/registry';
import FormatSelector from './FormatSelector';
import OptionsModal from './OptionsModal';
import AdBanner from './AdBanner';
import QueueItemRow from './workbench/QueueItemRow';

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
  zipError?: string | null;
  onDismissZipError?: () => void;
}

function getQueueStatusSummary(items: ConversionQueueItem[], isConverting: boolean): string {
  if (isConverting) return 'Converting queued files...';
  if (items.some((i) => !i.targetFormat?.trim())) return 'Please select an output format to continue';
  if (items.length > 0 && items.every((i) => i.status === 'completed')) {
    return items.length === 1 ? 'Conversion complete for 1 file' : `Conversion complete for ${items.length} files`;
  }
  const errorCount = items.filter((i) => i.status === 'error').length;
  if (errorCount > 0) {
    return errorCount === 1
      ? '1 file failed conversion. Retry or remove to continue.'
      : `${errorCount} files failed conversion. Retry or remove to continue.`;
  }
  return items.length === 1 ? 'Ready to convert 1 file' : `Ready to convert ${items.length} files`;
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

export default function ConversionQueue({
  items,
  onRemoveItem,
  onClearAll,
  onUpdateTargetFormat,
  onUpdateAllTargets,
  onUpdateOptions,
  onConvertAll,
  onConvertSingle,
  onAddMoreFiles,
  onDownloadAllZip,
  isConverting,
  zipError,
  onDismissZipError,
}: Readonly<ConversionQueueProps>) {
  const [activeFormatSelectorId, setActiveFormatSelectorId] = useState<string | null>(null);
  const [isBatchSelectorOpen, setIsBatchSelectorOpen] = useState(false);
  const [batchTargetLabel, setBatchTargetLabel] = useState<string>('');
  const [activeOptionsModalId, setActiveOptionsModalId] = useState<string | null>(null);

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const allDone = items.length > 0 && completedCount === items.length;
  const allHaveTarget = items.length > 0 && items.every((i) => Boolean(i.targetFormat?.trim()));
  const hasPending = items.some((i) => i.status === 'ready' || i.status === 'error');
  const statusSummary = getQueueStatusSummary(items, isConverting);
  const batchAvailableFormats = useMemo(() => collectBatchTargetFormats(items), [items]);
  const currentOptionsItem = items.find((i) => i.id === activeOptionsModalId);

  return (
    <>
      <div className="w-full rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm overflow-visible">
        {items.length > 1 && (
          <div className="px-4 sm:px-5 py-3 border-b border-neutral-border dark:border-dark-border flex flex-wrap items-center justify-between gap-3">
            {onUpdateAllTargets ? (
              <div className="flex items-center flex-wrap gap-2.5">
                <span className="text-xs font-medium text-ink-secondary dark:text-neutral-300">Convert all to</span>
                <div className="relative">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={isBatchSelectorOpen}
                    disabled={isConverting}
                    onClick={() => {
                      setActiveFormatSelectorId(null);
                      setIsBatchSelectorOpen((prev) => !prev);
                    }}
                    className="inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-md border border-neutral-300 dark:border-dark-border bg-white dark:bg-dark-elevated text-xs font-mono font-semibold uppercase text-brand-950 dark:text-white hover:border-brand-700 dark:hover:border-brand-400 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <span>{batchTargetLabel ? batchTargetLabel.toUpperCase() : 'Choose format'}</span>
                    <ChevronDown className="w-3.5 h-3.5 text-ink-muted dark:text-neutral-400" />
                  </button>
                  {isBatchSelectorOpen && (
                    <FormatSelector
                      availableFormats={batchAvailableFormats}
                      selectedFormatId={batchTargetLabel}
                      onSelect={(fmt) => {
                        setBatchTargetLabel(fmt);
                        onUpdateAllTargets(fmt);
                        setIsBatchSelectorOpen(false);
                      }}
                      onClose={() => setIsBatchSelectorOpen(false)}
                      title="Convert all compatible files to"
                    />
                  )}
                </div>
              </div>
            ) : (
              <span className="text-xs font-medium text-ink-secondary dark:text-neutral-300">{items.length} files in queue</span>
            )}

            <button
              type="button"
              disabled={isConverting}
              onClick={onClearAll}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-md text-xs font-medium text-ink-secondary dark:text-neutral-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear all</span>
            </button>
          </div>
        )}

        <div className="divide-y divide-neutral-border dark:divide-dark-border">
          {items.map((item) => (
            <QueueItemRow
              key={item.id}
              item={item}
              isFormatSelectorOpen={activeFormatSelectorId === item.id}
              onToggleFormatSelector={() => {
                setIsBatchSelectorOpen(false);
                setActiveFormatSelectorId((prev) => (prev === item.id ? null : item.id));
              }}
              onCloseFormatSelector={() => setActiveFormatSelectorId(null)}
              onSelectTargetFormat={(fmt) => {
                onUpdateTargetFormat(item.id, fmt);
                setActiveFormatSelectorId(null);
              }}
              onOpenOptions={() => setActiveOptionsModalId(item.id)}
              onRetry={() => onConvertSingle(item.id)}
              onRemove={() => onRemoveItem(item.id)}
            />
          ))}
        </div>

        <div className="bg-neutral-subtle dark:bg-[#121629] border-t border-neutral-border dark:border-dark-border rounded-b-xl px-4 sm:px-5 py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3">
          <div className="min-w-0">
            <output aria-live="polite" className="block text-sm text-ink-secondary dark:text-neutral-300">
              {statusSummary}
            </output>
            {zipError && (
              <div role="alert" className="mt-1 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                <span>{zipError}</span>
                {onDismissZipError && (
                  <button
                    type="button"
                    aria-label="Dismiss archive error"
                    onClick={onDismissZipError}
                    className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-md hover:bg-red-100 dark:hover:bg-red-950/40 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center flex-wrap sm:flex-nowrap gap-2.5 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={onAddMoreFiles}
              className="min-h-[48px] px-4 rounded-md bg-white hover:bg-neutral-50 active:bg-neutral-100 dark:bg-dark-surface dark:hover:bg-dark-elevated text-brand-950 dark:text-neutral-200 border border-neutral-300 dark:border-[#2C3452] text-sm font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <span>+ Add more files</span>
            </button>

            {completedCount > 1 && (
              <button
                type="button"
                onClick={onDownloadAllZip}
                className="min-h-[48px] px-4 rounded-md bg-brand-50 hover:bg-brand-100 dark:bg-brand-900/40 dark:hover:bg-brand-900/60 text-brand-800 dark:text-brand-200 border border-brand-200 dark:border-brand-700/50 text-sm font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <Package className="w-4 h-4 text-brand-700 dark:text-brand-300" />
                <span>Download All (.zip)</span>
              </button>
            )}

            {!allDone && (
              <button
                type="button"
                disabled={isConverting || !allHaveTarget || !hasPending}
                onClick={onConvertAll}
                className="min-h-[48px] px-6 rounded-md bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {isConverting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Converting...</span>
                  </>
                ) : (
                  <>
                    <span>Convert</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {completedCount > 0 && <AdBanner slot="post-conversion" className="mt-8" />}

      {currentOptionsItem?.targetFormat && (
        <OptionsModal
          filename={currentOptionsItem.name}
          sourceFormat={currentOptionsItem.sourceFormat}
          targetFormat={currentOptionsItem.targetFormat}
          initialOptions={currentOptionsItem.options}
          onSave={(opts) => {
            onUpdateOptions(currentOptionsItem.id, opts);
            setActiveOptionsModalId(null);
          }}
          onClose={() => setActiveOptionsModalId(null)}
        />
      )}
    </>
  );
}
