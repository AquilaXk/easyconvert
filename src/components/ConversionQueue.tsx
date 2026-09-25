'use client';

import React, { useState } from 'react';
import {
  FileText,
  FileImage,
  Database,
  Archive,
  Trash2,
  Settings2,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  Plus,
  Package,
} from 'lucide-react';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { getAvailableTargetFormats } from '@/lib/registry';
import FormatSelector from './FormatSelector';
import OptionsModal from './OptionsModal';

interface ConversionQueueProps {
  items: ConversionQueueItem[];
  onRemoveItem: (id: string) => void;
  onClearAll: () => void;
  onUpdateTargetFormat: (id: string, targetFormat: string) => void;
  onUpdateOptions: (id: string, options: ConversionOptions) => void;
  onConvertAll: () => void;
  onConvertSingle: (id: string) => void;
  onAddMoreFiles: () => void;
  onDownloadAllZip: () => void;
  isConverting: boolean;
}

export default function ConversionQueue({
  items,
  onRemoveItem,
  onClearAll,
  onUpdateTargetFormat,
  onUpdateOptions,
  onConvertAll,
  onConvertSingle,
  onAddMoreFiles,
  onDownloadAllZip,
  isConverting,
}: ConversionQueueProps) {
  const [activeFormatSelectorId, setActiveFormatSelectorId] = useState<string | null>(null);
  const [activeOptionsModalId, setActiveOptionsModalId] = useState<string | null>(null);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getFileIcon = (ext: string) => {
    const clean = ext.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'svg'].includes(clean)) {
      return <FileImage className="w-5 h-5 text-brand-600 dark:text-brand-400" />;
    }
    if (['pdf', 'md', 'html', 'txt'].includes(clean)) {
      return <FileText className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
    }
    if (['csv', 'tsv', 'json', 'yaml', 'xml'].includes(clean)) {
      return <Database className="w-5 h-5 text-brand-600 dark:text-brand-400" />;
    }
    return <Archive className="w-5 h-5 text-brand-600 dark:text-brand-400" />;
  };

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const readyCount = items.filter((i) => i.status === 'ready' || i.status === 'error').length;

  const currentSelectorItem = items.find((i) => i.id === activeFormatSelectorId);
  const currentOptionsItem = items.find((i) => i.id === activeOptionsModalId);

  return (
    <div className="w-full bg-white dark:bg-dark-surface rounded-2xl border border-neutral-border dark:border-dark-border shadow-xl overflow-hidden mb-12">
      {/* Table Header */}
      <div className="p-4 sm:p-5 border-b border-neutral-border dark:border-dark-border flex items-center justify-between bg-neutral-scaffold/50 dark:bg-dark-scaffold/50">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-brand-950 dark:text-dark-text">Files Queue</span>
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300">
            {items.length} {items.length === 1 ? 'file' : 'files'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-semibold text-ink-muted hover:text-status-danger transition-colors"
        >
          Clear Queue
        </button>
      </div>

      {/* Items List */}
      <div className="divide-y divide-neutral-border dark:divide-dark-border">
        {items.map((item) => {
          const availableTargets = getAvailableTargetFormats(item.sourceFormat);

          return (
            <div
              key={item.id}
              className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-neutral-scaffold/30 dark:hover:bg-dark-elevated/30 transition-colors"
            >
              {/* File Info */}
              <div className="flex items-center gap-3.5 min-w-0 md:w-5/12">
                <div className="p-2.5 rounded-xl bg-brand-50 dark:bg-dark-elevated border border-brand-200 dark:border-dark-border shrink-0">
                  {getFileIcon(item.sourceFormat)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-brand-950 dark:text-dark-text truncate" title={item.name}>
                    {item.name}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {formatFileSize(item.size)} &bull;{' '}
                    <span className="uppercase font-medium text-brand-700 dark:text-brand-400">
                      {item.sourceFormat}
                    </span>
                  </p>
                </div>
              </div>

              {/* Conversion Target & Settings */}
              <div className="flex items-center gap-3 md:w-4/12">
                <span className="text-xs text-ink-muted shrink-0">to</span>

                {/* Target selector dropdown button */}
                <button
                  type="button"
                  disabled={item.status === 'converting' || item.status === 'uploading'}
                  onClick={() => setActiveFormatSelectorId(item.id)}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs font-bold uppercase rounded-lg border border-neutral-border dark:border-dark-border bg-neutral-scaffold dark:bg-dark-elevated text-brand-950 dark:text-dark-text hover:border-brand-500 transition-colors shrink-0 min-w-[90px]"
                >
                  <span>{item.targetFormat}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
                </button>

                {/* Settings Wrench Button */}
                <button
                  type="button"
                  title="Configure conversion options"
                  onClick={() => setActiveOptionsModalId(item.id)}
                  disabled={item.status === 'converting' || item.status === 'uploading'}
                  className="p-2 rounded-lg text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 hover:bg-brand-50 dark:hover:bg-dark-elevated transition-colors"
                >
                  <Settings2 className="w-4 h-4" />
                </button>
              </div>

              {/* Status & Actions */}
              <div className="flex items-center justify-between md:justify-end gap-3 md:w-3/12">
                {/* Status Badges */}
                {item.status === 'ready' && (
                  <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted">
                    READY
                  </span>
                )}

                {(item.status === 'uploading' || item.status === 'converting') && (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-brand-700 dark:text-brand-400 animate-spin" />
                    <span className="text-xs font-semibold text-brand-700 dark:text-brand-400">
                      {item.status === 'uploading' ? 'UPLOADING...' : 'CONVERTING...'}
                    </span>
                  </div>
                )}

                {item.status === 'completed' && (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-status-successSoft text-status-success">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>FINISHED</span>
                    </span>
                    {item.resultUrl && (
                      <a
                        href={item.resultUrl}
                        download={`converted_${item.name.replace(/\.[^/.]+$/, '')}.${item.targetFormat}`}
                        className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold text-white bg-status-success hover:bg-emerald-700 rounded-lg shadow-sm transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download</span>
                      </a>
                    )}
                  </div>
                )}

                {item.status === 'error' && (
                  <div className="flex items-center gap-2" title={item.error}>
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-status-dangerSoft text-status-danger">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate max-w-[100px]">Error</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => onConvertSingle(item.id)}
                      className="text-xs font-semibold text-brand-700 dark:text-brand-300 hover:underline"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {/* Remove button */}
                <button
                  type="button"
                  onClick={() => onRemoveItem(item.id)}
                  title="Remove file"
                  className="p-1.5 text-ink-muted hover:text-status-danger hover:bg-status-dangerSoft/50 rounded-lg transition-colors ml-1"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Sticky Action Bar */}
      <div className="p-4 sm:p-5 bg-neutral-scaffold/80 dark:bg-dark-scaffold/80 border-t border-neutral-border dark:border-dark-border flex flex-col sm:flex-row items-center justify-between gap-4">
        <button
          type="button"
          onClick={onAddMoreFiles}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-brand-700 dark:text-brand-300 bg-white dark:bg-dark-surface border border-brand-300 dark:border-brand-800 hover:bg-brand-50 dark:hover:bg-dark-elevated rounded-xl shadow-sm transition-colors w-full sm:w-auto justify-center"
        >
          <Plus className="w-4 h-4" />
          <span>Add more Files</span>
        </button>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {completedCount > 1 && (
            <button
              type="button"
              onClick={onDownloadAllZip}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-brand-900 dark:text-brand-100 bg-brand-200 dark:bg-brand-900 hover:bg-brand-300 dark:hover:bg-brand-800 rounded-xl transition-colors"
            >
              <Package className="w-4 h-4" />
              <span>Download All (ZIP)</span>
            </button>
          )}

          <button
            type="button"
            disabled={isConverting || readyCount === 0}
            onClick={onConvertAll}
            className="flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-brand-700/25 transition-all hover:scale-[1.02] w-full sm:w-auto"
          >
            {isConverting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Converting...</span>
              </>
            ) : (
              <span>Convert {readyCount > 0 ? `(${readyCount})` : ''}</span>
            )}
          </button>
        </div>
      </div>

      {/* Format Selector Modal */}
      {currentSelectorItem && (
        <FormatSelector
          availableFormats={getAvailableTargetFormats(currentSelectorItem.sourceFormat)}
          selectedFormatId={currentSelectorItem.targetFormat}
          onSelect={(tgt) => onUpdateTargetFormat(currentSelectorItem.id, tgt)}
          onClose={() => setActiveFormatSelectorId(null)}
          title={`Convert ${currentSelectorItem.name} to:`}
        />
      )}

      {/* Options Modal */}
      {currentOptionsItem && (
        <OptionsModal
          filename={currentOptionsItem.name}
          sourceFormat={currentOptionsItem.sourceFormat}
          targetFormat={currentOptionsItem.targetFormat}
          initialOptions={currentOptionsItem.options}
          onSave={(opts) => onUpdateOptions(currentOptionsItem.id, opts)}
          onClose={() => setActiveOptionsModalId(null)}
        />
      )}
    </div>
  );
}
