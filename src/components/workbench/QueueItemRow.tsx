'use client';

import React from 'react';
import {
  FileText,
  FileImage,
  Database,
  Archive,
  Music,
  Video,
  BookOpen,
  Presentation,
  Type,
  Compass,
  X,
  Sliders,
  Download,
  ChevronDown,
} from 'lucide-react';
import { ConversionQueueItem } from '@/lib/types';
import { getAvailableTargetFormats, FORMAT_REGISTRY } from '@/lib/registry';
import FormatSelector from '../FormatSelector';

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

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${parseFloat(value.toFixed(1))} ${units[index]}`;
}

function getFormatLabel(ext: string): string {
  const clean = ext.toLowerCase();
  const def = FORMAT_REGISTRY[clean];
  if (def?.name) {
    return def.name;
  }
  return `${clean.toUpperCase()} File`;
}

function renderCategoryIcon(ext: string): React.ReactNode {
  const clean = ext.toLowerCase();
  const cat = FORMAT_REGISTRY[clean]?.category || 'document';

  switch (cat) {
    case 'audio':
      return <Music className="w-5 h-5 text-amber-600 dark:text-amber-400" />;
    case 'video':
      return <Video className="w-5 h-5 text-purple-600 dark:text-purple-400" />;
    case 'image':
      return <FileImage className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />;
    case 'vector':
    case 'cad':
      return <Compass className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />;
    case 'ebook':
      return <BookOpen className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />;
    case 'presentation':
      return <Presentation className="w-5 h-5 text-orange-600 dark:text-orange-400" />;
    case 'spreadsheet':
    case 'data':
      return <Database className="w-5 h-5 text-teal-600 dark:text-teal-400" />;
    case 'archive':
      return <Archive className="w-5 h-5 text-sky-600 dark:text-sky-400" />;
    case 'font':
      return <Type className="w-5 h-5 text-blue-600 dark:text-blue-400" />;
    default:
      if (clean === 'pdf') {
        return <FileText className="w-5 h-5 text-red-600 dark:text-red-400" />;
      }
      return <FileText className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
  }
}

function RowStatusDisplay({
  item,
  onRetry,
}: {
  item: ConversionQueueItem;
  onRetry: () => void;
}) {
  if (item.status === 'uploading' || item.status === 'converting') {
    const clampedProgress = Math.max(8, Math.min(100, Math.round(item.progress)));
    return (
      <div className="flex items-center gap-2 min-w-[140px]">
        <div
          role="progressbar"
          aria-valuenow={Math.round(item.progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Converting ${item.name}`}
          className="flex-1 h-2 bg-neutral-200 dark:bg-dark-elevated rounded-full overflow-hidden"
        >
          <div
            className="h-full bg-brand-700 transition-all duration-200 rounded-full"
            style={{ width: `${clampedProgress}%` }}
          />
        </div>
        <span className="text-xs font-mono text-ink-secondary dark:text-neutral-300 tabular-nums">
          {Math.round(item.progress)}%
        </span>
      </div>
    );
  }

  if (item.status === 'completed') {
    const baseName = item.name.replace(/\.[^/.]+$/, '') || item.name;
    const resultFilename = `${baseName}.${item.targetFormat}`;
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-status-successSoft text-status-success dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-500/30">
          Done
        </span>
        {item.resultUrl && (
          <a
            href={item.resultUrl}
            download={resultFilename}
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-md bg-status-success hover:opacity-95 text-white text-xs font-semibold transition-opacity"
          >
            <Download className="w-4 h-4" />
            <span>Download</span>
          </a>
        )}
      </div>
    );
  }

  if (item.status === 'error') {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-status-dangerSoft text-status-danger dark:bg-red-950/40 dark:text-red-300 border border-red-500/30">
          Failed
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center justify-center min-h-[44px] px-3.5 rounded-md border border-red-300 dark:border-red-800 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!item.targetFormat) {
    return null;
  }

  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-neutral-300 border border-neutral-border dark:border-dark-border">
      Ready
    </span>
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
}: QueueItemRowProps) {
  const isBusy = item.status === 'uploading' || item.status === 'converting';
  const hasTarget = Boolean(item.targetFormat);
  const isPdf = item.sourceFormat.toLowerCase() === 'pdf';

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
          {item.status === 'error' && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-1">
              {item.error || 'Conversion failed.'}
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
            disabled={isBusy}
            onClick={onToggleFormatSelector}
            className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-md border text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${targetButtonClass}`}
          >
            <span>{hasTarget ? item.targetFormat.toUpperCase() : 'Select format'}</span>
            <ChevronDown className="w-3.5 h-3.5 text-ink-muted dark:text-neutral-400" />
          </button>

          {isFormatSelectorOpen && (
            <>
              <div
                className="fixed inset-0 z-20 hidden sm:block"
                onClick={onCloseFormatSelector}
              />
              <div className="sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:z-30">
                <FormatSelector
                  sourceFormat={item.sourceFormat}
                  availableFormats={getAvailableTargetFormats(item.sourceFormat)}
                  selectedFormatId={item.targetFormat}
                  onSelect={(fmt) => {
                    onSelectTargetFormat(fmt);
                  }}
                  onClose={onCloseFormatSelector}
                  title={`Convert ${item.sourceFormat.toUpperCase()} to`}
                />
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          data-testid="queue-options-btn"
          aria-label={`Conversion options for ${item.name}`}
          disabled={isBusy}
          onClick={onOpenOptions}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] px-2.5 rounded-md border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-elevated text-ink-secondary dark:text-neutral-300 hover:border-brand-700 hover:text-brand-950 dark:hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Sliders className="w-4 h-4" />
        </button>

        <RowStatusDisplay item={item} onRetry={onRetry} />

        <button
          type="button"
          aria-label={`Remove ${item.name}`}
          onClick={onRemove}
          className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md text-ink-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
