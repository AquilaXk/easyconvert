'use client';

import React, { useState } from 'react';
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
import { getAvailableTargetFormats, FORMAT_REGISTRY } from '@/lib/registry';
import FormatSelector from './FormatSelector';
import OptionsModal from './OptionsModal';

interface ConversionQueueProps {
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
}: ConversionQueueProps) {
  const [activeFormatSelectorId, setActiveFormatSelectorId] = useState<string | null>(null);
  const [isBatchSelectorOpen, setIsBatchSelectorOpen] = useState(false);
  const [activeOptionsModalId, setActiveOptionsModalId] = useState<string | null>(null);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getFileCategoryIcon = (ext: string) => {
    const clean = ext.toLowerCase();
    const def = FORMAT_REGISTRY[clean];
    const cat = def?.category || 'document';

    switch (cat) {
      case 'audio':
        return <Music className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      case 'video':
        return <Video className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      case 'image':
        return <FileImage className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      case 'ebook':
        return <BookOpen className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      case 'presentation':
        return <Presentation className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      case 'spreadsheet':
      case 'data':
        return <Database className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      case 'archive':
        return <Archive className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      case 'font':
      case 'cad':
        return <Type className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
      default:
        return <FileText className="w-4 h-4 text-brand-700 dark:text-brand-400" />;
    }
  };

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const readyCount = items.filter((i) => i.status === 'ready' || i.status === 'error').length;

  const currentSelectorItem = items.find((i) => i.id === activeFormatSelectorId);
  const currentOptionsItem = items.find((i) => i.id === activeOptionsModalId);

  return (
    <div className="w-full bg-white dark:bg-neutral-900 rounded-3xl border border-neutral-200/80 dark:border-white/10 shadow-2xl ring-1 ring-black/[0.04] dark:ring-white/[0.06] overflow-hidden">
      {/* Table Header with Batch Target Action */}
      <div className="p-4 border-b border-neutral-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-3 bg-neutral-50 dark:bg-white/[0.02]">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold uppercase tracking-wider text-neutral-900 dark:text-white">
            Files Queue
          </span>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300">
            {items.length} {items.length === 1 ? 'file' : 'files'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Batch Convert All To button */}
          {items.length > 1 && onUpdateAllTargets && (
            <button
              type="button"
              onClick={() => setIsBatchSelectorOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg border border-neutral-200 dark:border-white/10 bg-white dark:bg-neutral-800 hover:border-brand-500 text-neutral-900 dark:text-white transition-colors"
            >
              <span className="text-neutral-500 dark:text-neutral-400">Convert all to:</span>
              <ChevronDown className="w-3 h-3 text-neutral-400" />
            </button>
          )}

          <button
            type="button"
            onClick={onClearAll}
            className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 hover:text-red-500 transition-colors"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Items List (High Density) */}
      <div className="divide-y divide-neutral-200 dark:divide-white/10">
        {items.map((item) => {
          return (
            <div
              key={item.id}
              className="p-3 sm:px-4 sm:py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-neutral-scaffold/30 dark:hover:bg-dark-elevated/30 transition-colors"
            >
              {/* File Info */}
              <div className="flex items-center gap-3 min-w-0 md:w-5/12">
                <div className="p-2 rounded-lg bg-brand-50 dark:bg-dark-elevated border border-brand-200 dark:border-dark-border shrink-0">
                  {getFileCategoryIcon(item.sourceFormat)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-brand-950 dark:text-dark-text truncate" title={item.name}>
                    {item.name}
                  </p>
                  <p className="text-[11px] text-ink-muted">
                    {formatFileSize(item.size)} &bull;{' '}
                    <span className="uppercase font-semibold text-brand-700 dark:text-brand-400">
                      {item.sourceFormat}
                    </span>
                  </p>
                </div>
              </div>

              {/* Conversion Target & Settings */}
              <div className="flex items-center gap-2 md:w-4/12">
                <span className="text-xs text-ink-muted shrink-0">to</span>

                {/* Target selector dropdown button */}
                <button
                  type="button"
                  disabled={item.status === 'converting' || item.status === 'uploading'}
                  onClick={() => setActiveFormatSelectorId(item.id)}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs font-bold uppercase rounded-lg border border-neutral-border dark:border-dark-border bg-neutral-scaffold dark:bg-dark-elevated text-brand-950 dark:text-dark-text hover:border-brand-500 transition-colors shrink-0 min-w-[84px]"
                >
                  <span>{item.targetFormat}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
                </button>

                {/* Settings Wrench Button */}
                <button
                  type="button"
                  title="Configure parameters (Quality, Codec, OCR, etc.)"
                  onClick={() => setActiveOptionsModalId(item.id)}
                  disabled={item.status === 'converting' || item.status === 'uploading'}
                  className="p-1.5 rounded-lg text-ink-secondary dark:text-dark-muted hover:text-brand-700 dark:hover:text-brand-300 hover:bg-neutral-scaffold dark:hover:bg-dark-elevated transition-colors"
                >
                  <Settings2 className="w-4 h-4" />
                </button>
              </div>

              {/* Status & Actions */}
              <div className="flex items-center justify-between md:justify-end gap-2.5 md:w-3/12">
                {/* Status Badges */}
                {item.status === 'ready' && (
                  <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted">
                    READY
                  </span>
                )}

                {(item.status === 'uploading' || item.status === 'converting') && (
                  <div className="flex flex-col items-end gap-1 w-full max-w-[130px]">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-brand-700 dark:text-brand-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>{item.status === 'uploading' ? 'UPLOADING...' : `${item.progress}%`}</span>
                    </div>
                    {/* Real Progress Bar */}
                    <div className="w-full bg-neutral-border dark:bg-dark-border h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-brand-700 h-full transition-all duration-300 rounded-full"
                        style={{ width: `${Math.max(10, item.progress)}%` }}
                      />
                    </div>
                  </div>
                )}

                {item.status === 'completed' && (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-status-successSoft text-status-success">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>FINISHED</span>
                    </span>
                    {item.resultUrl && (
                      <a
                        href={item.resultUrl}
                        download={`converted_${item.name.replace(/\.[^/.]+$/, '')}.${item.targetFormat}`}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-white bg-status-success hover:bg-emerald-700 rounded-lg shadow-sm transition-colors"
                      >
                        <Download className="w-3 h-3" />
                        <span>Download</span>
                      </a>
                    )}
                  </div>
                )}

                {item.status === 'error' && (
                  <div className="flex items-center gap-2" title={item.error}>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-status-dangerSoft text-status-danger">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      <span className="truncate max-w-[80px]">Error</span>
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
                  title="Remove from queue"
                  className="p-1 text-ink-muted hover:text-status-danger rounded-lg transition-colors ml-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Sticky Action Bar */}
      <div className="p-3.5 sm:px-5 bg-neutral-50 dark:bg-white/[0.02] border-t border-neutral-200 dark:border-white/10 flex flex-col sm:flex-row items-center justify-between gap-3">
        <button
          type="button"
          onClick={onAddMoreFiles}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-neutral-800 dark:text-neutral-200 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-white/10 hover:border-brand-500 rounded-lg shadow-sm transition-colors w-full sm:w-auto justify-center"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add more Files</span>
        </button>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {completedCount > 1 && (
            <button
              type="button"
              onClick={onDownloadAllZip}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-brand-900 dark:text-brand-100 bg-brand-200 dark:bg-brand-900 hover:bg-brand-300 dark:hover:bg-brand-800 rounded-lg transition-colors"
            >
              <Package className="w-3.5 h-3.5" />
              <span>Download All (ZIP)</span>
            </button>
          )}

          <button
            type="button"
            disabled={isConverting || readyCount === 0}
            onClick={onConvertAll}
            className="flex items-center justify-center gap-2 px-6 py-2 text-xs font-bold text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg shadow-sm shadow-brand-700/20 transition-all hover:scale-102 w-full sm:w-auto"
          >
            {isConverting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Converting...</span>
              </>
            ) : (
              <span>Convert {readyCount > 0 ? `(${readyCount})` : ''}</span>
            )}
          </button>
        </div>
      </div>

      {/* Format Selector Modal for single file */}
      {currentSelectorItem && (
        <FormatSelector
          availableFormats={getAvailableTargetFormats(currentSelectorItem.sourceFormat)}
          selectedFormatId={currentSelectorItem.targetFormat}
          onSelect={(tgt) => onUpdateTargetFormat(currentSelectorItem.id, tgt)}
          onClose={() => setActiveFormatSelectorId(null)}
          title={`Convert ${currentSelectorItem.name} to:`}
        />
      )}

      {/* Format Selector Modal for batch conversion */}
      {isBatchSelectorOpen && onUpdateAllTargets && (
        <FormatSelector
          selectedFormatId="pdf"
          onSelect={(tgt) => {
            onUpdateAllTargets(tgt);
            setIsBatchSelectorOpen(false);
          }}
          onClose={() => setIsBatchSelectorOpen(false)}
          title="Convert all queue files to:"
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
