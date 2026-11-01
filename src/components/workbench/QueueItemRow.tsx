'use client';

import React from 'react';
import {
  Archive, BookOpen, ChevronDown, Compass, Database, Download,
  FileImage, FileText, Music, Presentation, Sliders, Type, Video, X, type LucideIcon,
} from 'lucide-react';
import { ConversionQueueItem, FormatCategory } from '@/lib/types';
import { getAvailableTargetFormats, FORMAT_REGISTRY } from '@/lib/registry';
import { fileTooLargeMessage, maxFileBytes } from '@/lib/plan-limits';
import { formatBytes } from '@/lib/format-bytes';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import FormatSelector from '../FormatSelector';
import { getPasswordValidationError } from './options/options-capabilities';

export interface QueueItemRowProps {
  item: ConversionQueueItem;
  isFormatSelectorOpen: boolean;
  onToggleFormatSelector: () => void;
  onCloseFormatSelector: () => void;
  onSelectTargetFormat: (targetFormat: string) => void;
  onOpenOptions: () => void;
  onRetry: () => void;
  onRemove: () => void;
}

const CATEGORY_ICONS: Partial<Record<FormatCategory, { Icon: LucideIcon; color: string }>> = {
  audio: { Icon: Music, color: 'text-amber-600 dark:text-amber-400' },
  video: { Icon: Video, color: 'text-purple-600 dark:text-purple-400' },
  image: { Icon: FileImage, color: 'text-emerald-600 dark:text-emerald-400' },
  vector: { Icon: Compass, color: 'text-indigo-600 dark:text-indigo-400' },
  cad: { Icon: Compass, color: 'text-indigo-600 dark:text-indigo-400' },
  ebook: { Icon: BookOpen, color: 'text-indigo-600 dark:text-indigo-400' },
  presentation: { Icon: Presentation, color: 'text-orange-600 dark:text-orange-400' },
  spreadsheet: { Icon: Database, color: 'text-teal-600 dark:text-teal-400' },
  data: { Icon: Database, color: 'text-teal-600 dark:text-teal-400' },
  archive: { Icon: Archive, color: 'text-sky-600 dark:text-sky-400' },
  font: { Icon: Type, color: 'text-blue-600 dark:text-blue-400' },
};

function getFormatLabel(ext: string): string {
  const clean = ext.toLowerCase();
  return FORMAT_REGISTRY[clean]?.name || `${clean.toUpperCase()} File`;
}

function renderCategoryIcon(ext: string): React.ReactNode {
  const clean = ext.toLowerCase();
  if (clean === 'pdf') return <FileText className="w-5 h-5 text-red-600 dark:text-red-400" />;
  const entry = CATEGORY_ICONS[FORMAT_REGISTRY[clean]?.category || 'document'];
  if (entry) {
    const { Icon, color } = entry;
    return <Icon className={`w-5 h-5 ${color}`} />;
  }
  return <FileText className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
}

function resolveOptionError(item: ConversionQueueItem): string | null {
  if (!item.targetFormat) return null;
  return getPasswordValidationError(item.sourceFormat, item.targetFormat, item.options.password);
}

function resolveRowError(item: ConversionQueueItem, optionError: string | null, oversizeError: string | null): string | null {
  if (oversizeError) return oversizeError;
  if (optionError) return optionError;
  return item.status === 'error' ? item.error || 'Conversion failed.' : null;
}

function isRetryDisabled(
  item: ConversionQueueItem,
  isBusy: boolean,
  isOversize: boolean,
  optionError: string | null
): boolean {
  return isBusy || !item.targetFormat || isOversize || optionError !== null;
}

function RowStatusDisplay({
  item, isBusy, isOversize, optionError, onRetry,
}: Readonly<{
  item: ConversionQueueItem;
  isBusy: boolean;
  isOversize: boolean;
  optionError: string | null;
  onRetry: () => void;
}>) {
  if (isBusy) {
    const rounded = Math.round(item.progress);
    return (
      <div className="flex items-center gap-2 min-w-[140px]">
        <progress
          value={rounded} max={100} aria-label={`${item.status === 'uploading' ? 'Uploading' : 'Converting'} ${item.name}`}
          className="flex-1 h-2 w-full rounded-full overflow-hidden accent-brand-700 [&::-webkit-progress-bar]:bg-neutral-200 dark:[&::-webkit-progress-bar]:bg-dark-elevated [&::-webkit-progress-value]:bg-brand-700 [&::-moz-progress-bar]:bg-brand-700"
        />
        <span className="text-xs font-mono text-ink-secondary dark:text-neutral-300 tabular-nums">{rounded}%</span>
      </div>
    );
  }
  if (item.status === 'completed') {
    const baseName = item.name.replace(/\.[^/.]+$/, '') || item.name;
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-status-successSoft text-status-success dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-500/30">Done</span>
        {item.resultUrl && (
          <a
            href={item.resultUrl} download={`${baseName}.${item.targetFormat}`}
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-md bg-status-success hover:opacity-95 text-white text-xs font-semibold transition-opacity"
          >
            <Download className="w-4 h-4" /><span>Download</span>
          </a>
        )}
      </div>
    );
  }
  if (item.status === 'error' || isOversize || optionError !== null) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-status-dangerSoft text-status-danger dark:bg-red-950/40 dark:text-red-300 border border-red-500/30">Failed</span>
        <button
          type="button" disabled={isRetryDisabled(item, isBusy, isOversize, optionError)} onClick={onRetry}
          className="inline-flex items-center justify-center min-h-[44px] px-3.5 rounded-md border border-red-300 dark:border-red-800 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!item.targetFormat) return null;
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-neutral-300 border border-neutral-border dark:border-dark-border">Ready</span>
  );
}

export default function QueueItemRow({
  item,
  isFormatSelectorOpen,
  onToggleFormatSelector,
  onCloseFormatSelector,
  onSelectTargetFormat,
  onOpenOptions,
  onRetry,
  onRemove,
}: Readonly<QueueItemRowProps>) {
  const isBusy = item.status === 'uploading' || item.status === 'converting';
  const plan = useViewerPlan();
  const isIdle = !isBusy && item.status !== 'completed';
  // Read at render, not when the file was dropped: the plan of the session may answer after the drop.
  const isOversize = isIdle && item.size > maxFileBytes(plan);
  const hasTarget = Boolean(item.targetFormat);
  const isPdf = item.sourceFormat.toLowerCase() === 'pdf';
  const optionError = isIdle ? resolveOptionError(item) : null;
  const rowError = isIdle ? resolveRowError(item, optionError, isOversize ? fileTooLargeMessage(plan, item.size) : null) : null;

  const iconTileClass = isPdf
    ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/40'
    : 'bg-brand-50 dark:bg-brand-900/30 border-brand-200/80 dark:border-brand-700/30';

  const targetButtonClass = hasTarget
    ? 'border-neutral-300 dark:border-dark-border bg-white dark:bg-dark-elevated text-brand-950 dark:text-white hover:border-brand-700 dark:hover:border-brand-400 font-mono font-semibold uppercase'
    : 'border-amber-400 dark:border-amber-600 bg-amber-50/60 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 hover:border-brand-700 font-medium';

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 min-w-0">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className={`w-10 h-10 rounded-lg border shrink-0 flex items-center justify-center ${iconTileClass}`}>
          {renderCategoryIcon(item.sourceFormat)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-brand-950 dark:text-white truncate" title={item.name}>
            {item.name}
          </p>
          <p className="text-xs text-ink-secondary dark:text-neutral-400 flex items-center flex-wrap gap-1.5 mt-0.5">
            <span className="font-mono">{formatBytes(item.size)}</span>
            <span aria-hidden="true">&bull;</span>
            <span>{getFormatLabel(item.sourceFormat)}</span>
          </p>
          {rowError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-1">
              {rowError}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-2 shrink-0">
        <span className="text-xs text-ink-muted dark:text-neutral-400 font-medium">to</span>

        <div className="relative">
          <button
            type="button"
            data-testid="queue-target-format-btn"
            aria-label={`Select output format for ${item.name}`}
            aria-haspopup="dialog"
            aria-expanded={isFormatSelectorOpen}
            disabled={isBusy || isOversize}
            onClick={onToggleFormatSelector}
            className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-md border text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${targetButtonClass}`}
          >
            <span>{hasTarget ? item.targetFormat.toUpperCase() : 'Select format'}</span>
            <ChevronDown className="w-3.5 h-3.5 text-ink-muted dark:text-neutral-400" />
          </button>

          {isFormatSelectorOpen && !isOversize && (
            <FormatSelector
              sourceFormat={item.sourceFormat}
              availableFormats={getAvailableTargetFormats(item.sourceFormat)}
              selectedFormatId={item.targetFormat}
              onSelect={onSelectTargetFormat}
              onClose={onCloseFormatSelector}
              title={`Convert ${item.sourceFormat.toUpperCase()} to`}
            />
          )}
        </div>

        <button
          type="button"
          data-testid="queue-options-btn"
          aria-label={`Conversion options for ${item.name}`}
          disabled={!item.targetFormat || isBusy || isOversize}
          onClick={onOpenOptions}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] px-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-elevated text-ink-secondary dark:text-neutral-300 hover:border-brand-700 hover:text-brand-950 dark:hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Sliders className="w-4 h-4" />
        </button>

        <RowStatusDisplay
          item={item}
          isBusy={isBusy}
          isOversize={isOversize}
          optionError={optionError}
          onRetry={onRetry}
        />

        <button
          type="button"
          aria-label={`${isBusy ? 'Cancel' : 'Remove'} ${item.name}`}
          onClick={onRemove}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md text-ink-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
