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
  FilePlus,
  RefreshCw,
  Info,
  Package,
  HardDrive,
  Globe,
  FolderOpen,
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
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);

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
        return <Music className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      case 'video':
        return <Video className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      case 'image':
        return <FileImage className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      case 'ebook':
        return <BookOpen className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      case 'presentation':
        return <Presentation className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      case 'spreadsheet':
      case 'data':
        return <Database className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      case 'archive':
        return <Archive className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      case 'font':
      case 'cad':
        return <Type className="w-5 h-5 text-brand-700 dark:text-brand-300" />;
      default:
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
            return (
              <div
                key={item.id}
                className="px-5 sm:px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-colors hover:bg-brand-50/40 dark:hover:bg-white/[0.02]"
              >
                {/* File Information */}
                <div className="flex items-center gap-3.5 min-w-0 md:w-5/12">
                  <div className="p-2.5 rounded-xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200/80 dark:border-brand-700/30 shrink-0">
                    {getFileCategoryIcon(item.sourceFormat)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-brand-950 dark:text-white truncate" title={item.name}>
                      {item.name}
                    </p>
                    <p className="text-xs text-ink-secondary dark:text-neutral-400 font-medium">
                      {formatFileSize(item.size)} &bull; {getFormatLabel(item.sourceFormat)}
                    </p>
                  </div>
                </div>

                {/* Conversion Target & Settings & Status */}
                <div className="relative flex items-center justify-between md:justify-end gap-3 flex-wrap md:flex-nowrap flex-1">
                  {/* Convert indicator */}
                  <div className="hidden sm:flex items-center gap-1.5 text-xs text-ink-muted dark:text-neutral-400 font-medium">
                    <RefreshCw className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" />
                    <span>to</span>
                  </div>

                  {/* Target format selector button */}
                  {item.targetFormat ? (
                    <button
                      type="button"
                      data-testid="queue-target-format-btn"
                      disabled={item.status === 'converting' || item.status === 'uploading'}
                      onClick={() => setActiveFormatSelectorId(activeFormatSelectorId === item.id ? null : item.id)}
                      className="flex items-center gap-2 px-3.5 py-1.5 text-xs font-mono font-bold uppercase rounded-xl border border-brand-300 dark:border-neutral-700 bg-brand-50/80 dark:bg-[#14182B] text-brand-900 dark:text-white hover:border-brand-700 hover:bg-brand-100/60 dark:hover:border-neutral-500 shadow-sm transition-colors cursor-pointer"
                    >
                      <span>{item.targetFormat}</span>
                      <ChevronDown className="w-3.5 h-3.5 text-brand-700 dark:text-neutral-400" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="queue-target-format-btn"
                      disabled={item.status === 'converting' || item.status === 'uploading'}
                      onClick={() => setActiveFormatSelectorId(activeFormatSelectorId === item.id ? null : item.id)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-xl border-2 border-dashed border-brand-700 text-brand-700 dark:text-brand-300 bg-brand-50/50 dark:bg-brand-900/20 hover:bg-brand-100/60 shadow-sm transition-colors cursor-pointer"
                    >
                      <span>Select Format</span>
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Options button (visible when target is chosen) */}
                  {item.targetFormat && (
                    <button
                      type="button"
                      data-testid="queue-options-btn"
                      title="Options"
                      disabled={item.status === 'converting' || item.status === 'uploading'}
                      onClick={() => setActiveOptionsModalId(item.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border border-neutral-border dark:border-neutral-700 bg-white dark:bg-[#14182B] text-ink-secondary dark:text-neutral-300 hover:border-brand-400 hover:text-brand-950 dark:hover:text-white shadow-sm transition-colors cursor-pointer"
                    >
                      <Sliders className="w-3.5 h-3.5 text-ink-muted dark:text-neutral-400" />
                      <span>Options</span>
                    </button>
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
                      <span>{item.edgeTier || 'Edge L0 (Instant)'}</span>
                      <span className="text-emerald-500/40">&bull;</span>
                      <span>0B Uploaded</span>
                    </span>
                  )}

                  {item.status === 'completed' && !item.edgeProcessed && (
                    <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-400 bg-sky-500/10 border border-sky-500/25 px-2.5 py-1 rounded-lg">
                      <span>{item.edgeTier || 'Cloud (Zero-Retention)'}</span>
                    </span>
                  )}

                  {item.status === 'completed' && item.resultUrl && (
                    <a
                      href={item.resultUrl}
                      download={`converted_${item.name.replace(/\.[^/.]+$/, '')}.${item.targetFormat}`}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-sm transition-colors"
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

                  {/* Delete button */}
                  <button
                    type="button"
                    onClick={() => onRemoveItem(item.id)}
                    title="Delete"
                    className="p-1.5 text-ink-muted hover:text-red-600 dark:hover:text-white rounded-lg hover:bg-red-50 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>

                  {/* Target Format Selector Popover anchored directly under row actions */}
                  {activeFormatSelectorId === item.id && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setActiveFormatSelectorId(null)}
                      />
                      <div className="absolute right-0 top-full mt-2 z-50">
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
              </div>
            );
          })}
        </div>
      </div>

      {/* Post-Conversion Ad Unit */}
      <AdBanner slot="post-conversion" className="mt-8 mb-4" />

      {/* Fixed Sticky Action Bar: Crisp Light Surface & Elevated Dark Surface */}
      <div className="fixed bottom-0 inset-x-0 h-16 sm:h-18 bg-white/95 dark:bg-[#14182B]/95 backdrop-blur-md border-t border-neutral-border dark:border-[#283252] z-40 px-4 sm:px-8 flex items-center justify-between shadow-2xl transition-colors">
        <div className="max-w-8xl mx-auto w-full flex items-center justify-between">
          {/* Left Side Status */}
          <div className="flex items-center gap-2 text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 font-medium">
            {!allReady ? (
              <>
                <Info className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                <span>Please select output format</span>
              </>
            ) : (
              <span>
                {items.length} {items.length === 1 ? 'file ready' : 'files ready'}
              </span>
            )}
          </div>

          {/* Right Side Buttons */}
          <div className="flex items-center gap-3">
            {/* Download all zip if multiple completed */}
            {completedCount > 1 && (
              <button
                type="button"
                onClick={onDownloadAllZip}
                className="flex items-center gap-1.5 px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-bold text-brand-700 dark:text-brand-300 bg-brand-100 hover:bg-brand-200 dark:bg-brand-900/40 dark:hover:bg-brand-900/60 rounded-xl transition-colors border border-brand-300/60 dark:border-brand-700/40 cursor-pointer"
              >
                <Package className="w-4 h-4" />
                <span>Download All (ZIP)</span>
              </button>
            )}

            {/* Add more files split button */}
            <div className="relative inline-flex shadow-sm">
              <button
                type="button"
                onClick={onAddMoreFiles}
                className="bg-white hover:bg-neutral-50 dark:bg-[#1E2540] dark:hover:bg-[#252E4E] text-brand-950 dark:text-white border border-neutral-border dark:border-[#2C375A] rounded-l-xl text-xs sm:text-sm font-semibold flex items-center gap-2 px-3.5 py-2 sm:py-2.5 transition-colors cursor-pointer"
              >
                <FilePlus className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                <span>Add more files</span>
              </button>
              <button
                type="button"
                onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
                aria-label="Select file source"
                className="bg-white hover:bg-neutral-50 dark:bg-[#1E2540] dark:hover:bg-[#252E4E] text-brand-950 dark:text-white border-y border-r border-neutral-border dark:border-[#2C375A] rounded-r-xl text-xs sm:text-sm font-medium p-2 sm:p-2.5 transition-colors cursor-pointer"
              >
                <ChevronDown className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
              </button>

              {isAddMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setIsAddMenuOpen(false)}
                  />
                  <div className="absolute bottom-full right-0 mb-2 w-56 bg-white dark:bg-[#181D30] border border-neutral-border dark:border-[#2C375A] rounded-2xl shadow-2xl p-1.5 z-50 animate-in fade-in duration-150 text-left">
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                    >
                      <HardDrive className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                      <span>From my computer</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                    >
                      <Globe className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                      <span>By URL</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                    >
                      <FolderOpen className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                      <span>From Google Drive</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                    >
                      <Archive className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                      <span>From Dropbox</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                    >
                      <FolderOpen className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                      <span>From OneDrive</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Main Convert CTA button: [ 🔄 Convert ] in Signature brand.700 */}
            <button
              type="button"
              disabled={isConverting || !allReady}
              onClick={onConvertAll}
              className="bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white px-6 sm:px-8 py-2.5 sm:py-3 rounded-xl font-bold text-sm sm:text-base flex items-center gap-2 shadow-lg shadow-brand-700/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              {isConverting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Converting...</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4" />
                  <span>Convert</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

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
