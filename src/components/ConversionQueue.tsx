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
  X,
  Sliders,
  Download,
  Loader2,
  ChevronDown,
  Info,
  Package,
  ArrowRight,
} from 'lucide-react';
import { ConversionQueueItem, ConversionOptions } from '@/lib/types';
import { getAvailableTargetFormats, FORMAT_REGISTRY } from '@/lib/registry';
import FormatSelector from './FormatSelector';
import OptionsModal from './OptionsModal';
import AdBanner from './AdBanner';

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
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getFormatLabel = (ext: string) => {
    const clean = ext.toLowerCase();
    const def = FORMAT_REGISTRY[clean];
    if (def?.name) return def.name;
    const cat = def?.category || 'file';
    return `${clean.toUpperCase()} ${cat.charAt(0).toUpperCase() + cat.slice(1)}`;
  };

  const getFileCategoryIcon = (ext: string) => {
    const clean = ext.toLowerCase();
    const def = FORMAT_REGISTRY[clean];
    const cat = def?.category || 'document';

    switch (cat) {
      case 'audio':
        return <Music className="w-5 h-5 text-amber-600 dark:text-amber-400" />;
      case 'video':
        return <Video className="w-5 h-5 text-purple-600 dark:text-purple-400" />;
      case 'image':
        return <FileImage className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />;
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
      case 'cad':
        return <Type className="w-5 h-5 text-blue-600 dark:text-blue-400" />;
      default:
        if (clean === 'pdf') {
          return <FileText className="w-5 h-5 text-red-500 dark:text-red-400" />;
        }
        return <FileText className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
    }
  };

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const allReady = items.length > 0 && items.every((i) => i.targetFormat && i.targetFormat.trim() !== '');

  const currentOptionsItem = items.find((i) => i.id === activeOptionsModalId);

  return (
    <>
      {/* File Staging Table Card: Crisp Light Surface & High-Contrast Dark Surface */}
      <div className="w-full bg-white dark:bg-[#181D30] rounded-2xl border border-neutral-border dark:border-[#2C375A] shadow-xl overflow-visible transition-colors">
        <div className="divide-y divide-neutral-border dark:divide-[#252E4B]">
          {items.map((item) => {
            const isPdf = item.sourceFormat.toLowerCase() === 'pdf';
            return (
              <div
                key={item.id}
                className="px-5 sm:px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-colors hover:bg-brand-50/40 dark:hover:bg-white/[0.02]"
              >
                {/* File Information */}
                <div className="flex items-center gap-3.5 min-w-0 md:w-5/12">
                  <div
                    className={`p-2.5 rounded-xl border shrink-0 ${
                      isPdf
                        ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/40'
                        : 'bg-brand-50 dark:bg-brand-900/40 border-brand-200/80 dark:border-brand-700/30'
                    }`}
                  >
                    {getFileCategoryIcon(item.sourceFormat)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-brand-950 dark:text-white truncate" title={item.name}>
                      {item.name}
                    </p>
                    <p className="text-xs text-ink-secondary dark:text-neutral-400 font-medium">
                      {getFormatLabel(item.sourceFormat)}
                    </p>
                  </div>
                </div>

                {/* Conversion Target & Settings & Status */}
                <div className="relative flex items-center justify-between md:justify-end gap-3 flex-wrap md:flex-nowrap flex-1">
                  {/* Convert indicator */}
                  <span className="text-xs text-ink-muted dark:text-neutral-400 font-medium">to</span>

                  {/* Target format selector button: compact tactile [ ... ▼ ] or [ DOCX ▼ ] with popover anchored directly beneath */}
                  <div className="relative inline-block">
                    {item.targetFormat ? (
                      <button
                        type="button"
                        data-testid="queue-target-format-btn"
                        disabled={item.status === 'converting' || item.status === 'uploading'}
                        onClick={() => setActiveFormatSelectorId(activeFormatSelectorId === item.id ? null : item.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold uppercase rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-[#14182B] text-brand-950 dark:text-white hover:border-brand-700 dark:hover:border-brand-400 shadow-xs transition-colors cursor-pointer"
                      >
                        <span>{item.targetFormat}</span>
                        <ChevronDown className="w-3.5 h-3.5 text-ink-muted dark:text-neutral-400" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="queue-target-format-btn"
                        disabled={item.status === 'converting' || item.status === 'uploading'}
                        onClick={() => setActiveFormatSelectorId(activeFormatSelectorId === item.id ? null : item.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold rounded-lg border border-dashed border-brand-500 text-brand-700 dark:text-brand-300 bg-brand-50/50 dark:bg-brand-900/20 hover:bg-brand-100/60 shadow-xs transition-colors cursor-pointer"
                      >
                        <span>...</span>
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* 2-Column Searchable Target Format Selector Popover */}
                    {activeFormatSelectorId === item.id && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setActiveFormatSelectorId(null)}
                        />
                        <div className="absolute right-0 sm:right-auto sm:left-0 top-full mt-2 z-50">
                          <FormatSelector
                            availableFormats={getAvailableTargetFormats(item.sourceFormat)}
                            selectedFormatId={item.targetFormat}
                            onSelect={(fmt) => {
                              onUpdateTargetFormat(item.id, fmt);
                              setActiveFormatSelectorId(null);
                            }}
                            onClose={() => setActiveFormatSelectorId(null)}
                            title={`Convert ${item.sourceFormat.toUpperCase()} to:`}
                          />
                        </div>
                      </>
                    )}
                  </div>

                  {/* Options button (visible when target is chosen) */}
                  {item.targetFormat && (
                    <button
                      type="button"
                      data-testid="queue-options-btn"
                      title="Options"
                      disabled={item.status === 'converting' || item.status === 'uploading'}
                      onClick={() => setActiveOptionsModalId(item.id)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-neutral-border dark:border-neutral-700 bg-white dark:bg-[#14182B] text-ink-secondary dark:text-neutral-300 hover:border-brand-400 hover:text-brand-950 dark:hover:text-white shadow-xs transition-colors cursor-pointer"
                    >
                      <Sliders className="w-3.5 h-3.5 text-ink-muted dark:text-neutral-400" />
                      <span className="hidden sm:inline">Options</span>
                    </button>
                  )}

                  {/* Ready Status Badge matching Reference 1 */}
                  {item.status === 'ready' && (
                    <span className="hidden sm:inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-medium tracking-wide uppercase text-emerald-600 dark:text-emerald-400 border border-emerald-500/60 bg-emerald-50/40 dark:bg-emerald-950/20">
                      Ready
                    </span>
                  )}

                  {/* Progress / Status / Finished Actions */}
                  {(item.status === 'uploading' || item.status === 'converting') && (
                    <div className="flex items-center gap-2 min-w-[120px]">
                      <Loader2 className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400 animate-spin" />
                      <div className="w-full bg-neutral-200 dark:bg-neutral-700 h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-brand-700 h-full transition-all duration-300 rounded-full"
                          style={{ width: `${Math.max(15, item.progress)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {item.status === 'completed' && item.edgeProcessed && (
                    <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg">
                      <span>{item.edgeTier || 'Edge L0'}</span>
                    </span>
                  )}

                  {item.status === 'completed' && !item.edgeProcessed && (
                    <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded-lg">
                      <span>{item.edgeTier || 'Client Edge'}</span>
                    </span>
                  )}

                  {item.status === 'completed' && item.resultUrl && (
                    <a
                      href={item.resultUrl}
                      download={`converted_${item.name.replace(/\.[^/.]+$/, '')}.${item.targetFormat}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </a>
                  )}

                  {item.status === 'error' && (
                    <button
                      type="button"
                      onClick={() => onConvertSingle(item.id)}
                      className="text-xs font-semibold text-red-600 hover:underline px-2 py-1"
                    >
                      Retry
                    </button>
                  )}

                  {/* File Size */}
                  <span className="text-xs font-mono text-ink-muted dark:text-neutral-400 min-w-[55px] text-right">
                    {formatFileSize(item.size)}
                  </span>

                  {/* Delete button */}
                  <button
                    type="button"
                    onClick={() => onRemoveItem(item.id)}
                    title="Delete"
                    className="p-1 text-ink-muted hover:text-red-600 dark:hover:text-white rounded-lg hover:bg-red-50 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Attached Conversion Dock directly on the table card matching Reference 1 */}
        <div className="bg-[#1F2340] dark:bg-[#111424] text-white px-5 sm:px-6 py-4 rounded-b-2xl border-t border-neutral-200 dark:border-[#2C375A] flex items-center justify-between gap-4 flex-wrap">
          {/* Left: Add more files button matching Reference 1 */}
          <button
            type="button"
            onClick={onAddMoreFiles}
            className="bg-white hover:bg-neutral-100 active:bg-neutral-200 text-brand-950 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2 px-4 py-2.5 transition-colors cursor-pointer shadow-sm"
          >
            <span className="text-brand-700 font-bold text-base leading-none">+</span>
            <span>Add more files</span>
          </button>

          {/* Center helper hint matching Reference 1 & 2 */}
          <div className="hidden lg:flex items-center gap-2 text-xs text-neutral-300 dark:text-neutral-400 font-normal">
            {!allReady ? (
              <span className="text-amber-300 font-medium flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0" />
                <span>Please select output format</span>
              </span>
            ) : (
              <span>Ctrl or Shift to select multiple files</span>
            )}
          </div>

          {/* Right: Download all zip and Convert button */}
          <div className="flex items-center gap-3">
            {completedCount > 1 && (
              <button
                type="button"
                onClick={onDownloadAllZip}
                className="flex items-center gap-1.5 px-4 py-2.5 text-xs sm:text-sm font-bold text-white bg-brand-800 hover:bg-brand-900 rounded-xl transition-colors border border-white/10 cursor-pointer"
              >
                <Package className="w-4 h-4" />
                <span>Download All (ZIP)</span>
              </button>
            )}

            <button
              type="button"
              disabled={isConverting || !allReady}
              onClick={onConvertAll}
              className="bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white px-8 sm:px-10 py-3 rounded-xl font-bold text-sm sm:text-base flex items-center gap-2.5 shadow-lg shadow-brand-700/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer"
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
          </div>
        </div>
      </div>

      {/* Post-Conversion Ad Unit */}
      <AdBanner slot="post-conversion" className="mt-8 mb-4" />

      {/* Options Modal */}
      {currentOptionsItem && (
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
