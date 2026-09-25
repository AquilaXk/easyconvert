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
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  Plus,
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
        return <Music className="w-5 h-5 text-neutral-400" />;
      case 'video':
        return <Video className="w-5 h-5 text-neutral-400" />;
      case 'image':
        return <FileImage className="w-5 h-5 text-neutral-400" />;
      case 'ebook':
        return <BookOpen className="w-5 h-5 text-neutral-400" />;
      case 'presentation':
        return <Presentation className="w-5 h-5 text-neutral-400" />;
      case 'spreadsheet':
      case 'data':
        return <Database className="w-5 h-5 text-neutral-400" />;
      case 'archive':
        return <Archive className="w-5 h-5 text-neutral-400" />;
      case 'font':
      case 'cad':
        return <Type className="w-5 h-5 text-neutral-400" />;
      default:
        return <FileText className="w-5 h-5 text-neutral-400" />;
    }
  };

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const allReady = items.length > 0 && items.every((i) => i.targetFormat && i.targetFormat.trim() !== '');

  const currentSelectorItem = items.find((i) => i.id === activeFormatSelectorId);
  const currentOptionsItem = items.find((i) => i.id === activeOptionsModalId);

  return (
    <div className="w-full bg-white dark:bg-neutral-900 rounded-3xl border border-neutral-200/80 dark:border-white/10 shadow-2xl ring-1 ring-black/[0.04] dark:ring-white/[0.06] overflow-visible">
      {/* File Items List */}
      <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {items.map((item) => {
          return (
            <div
              key={item.id}
              className="px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-neutral-50/50 dark:hover:bg-neutral-800/30 transition-colors"
            >
              {/* File Info */}
              <div className="flex items-center gap-3.5 min-w-0 md:w-5/12">
                <div className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 shrink-0">
                  {getFileCategoryIcon(item.sourceFormat)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate" title={item.name}>
                    {item.name}
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {formatFileSize(item.size)} &bull; {getFormatLabel(item.sourceFormat)}
                  </p>
                </div>
              </div>

              {/* Conversion Target & Settings & Status */}
              <div className="flex items-center justify-between md:justify-end gap-3 flex-wrap md:flex-nowrap flex-1">
                {/* Convert indicator */}
                <div className="hidden sm:flex items-center gap-1.5 text-xs text-neutral-400">
                  <RefreshCw className="w-3.5 h-3.5 text-[#5C6BC0]" />
                  <span>Convert</span>
                </div>

                {/* Source format badge */}
                <span className="px-2.5 py-1 text-xs font-mono font-bold uppercase rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200">
                  {item.sourceFormat}
                </span>

                <span className="text-neutral-400 text-xs font-bold">&rarr;</span>

                {/* Target format selector button */}
                {item.targetFormat ? (
                  <button
                    type="button"
                    data-testid="queue-target-format-btn"
                    disabled={item.status === 'converting' || item.status === 'uploading'}
                    onClick={() => setActiveFormatSelectorId(item.id)}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono font-bold uppercase rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white hover:border-[#5C6BC0] transition-colors"
                  >
                    <span>{item.targetFormat}</span>
                    <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="queue-target-format-btn"
                    disabled={item.status === 'converting' || item.status === 'uploading'}
                    onClick={() => setActiveFormatSelectorId(item.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-[#5C6BC0] text-[#5C6BC0] hover:bg-[#5C6BC0]/10 transition-colors"
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
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:border-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>Options</span>
                  </button>
                )}

                {/* Progress / Status / Finished Actions */}
                {(item.status === 'uploading' || item.status === 'converting') && (
                  <div className="flex items-center gap-2 min-w-[120px]">
                    <Loader2 className="w-3.5 h-3.5 text-[#5C6BC0] animate-spin" />
                    <div className="w-full bg-neutral-200 dark:bg-neutral-700 h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-[#5C6BC0] h-full transition-all duration-300 rounded-full"
                        style={{ width: `${Math.max(15, item.progress)}%` }}
                      />
                    </div>
                  </div>
                )}

                {item.status === 'completed' && item.resultUrl && (
                  <a
                    href={item.resultUrl}
                    download={`converted_${item.name.replace(/\.[^/.]+$/, '')}.${item.targetFormat}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-md shadow-sm transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download</span>
                  </a>
                )}

                {item.status === 'error' && (
                  <button
                    type="button"
                    onClick={() => onConvertSingle(item.id)}
                    className="text-xs font-semibold text-red-500 hover:underline"
                  >
                    Retry
                  </button>
                )}

                {/* Delete button */}
                <button
                  type="button"
                  onClick={() => onRemoveItem(item.id)}
                  title="Delete"
                  className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-md transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Sticky Action Bar */}
      <div className="px-6 py-4 bg-neutral-50/80 dark:bg-neutral-900 border-t border-neutral-200 dark:border-neutral-800 flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Left Side Status */}
        <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          {!allReady ? (
            <>
              <Info className="w-4 h-4 text-neutral-400" />
              <span>Please select output format</span>
            </>
          ) : (
            <span>
              {items.length} {items.length === 1 ? 'file ready' : 'files ready'}
            </span>
          )}
        </div>

        {/* Right Side Buttons */}
        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {/* Download all zip if multiple completed */}
          {completedCount > 1 && (
            <button
              type="button"
              onClick={onDownloadAllZip}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-[#5C6BC0] dark:text-[#7986CB] bg-[#5C6BC0]/10 hover:bg-[#5C6BC0]/20 rounded-md transition-colors"
            >
              <Package className="w-3.5 h-3.5" />
              <span>Download All (ZIP)</span>
            </button>
          )}

          {/* Add more files split button */}
          <div className="relative inline-flex -space-x-px rounded-md shadow-sm">
            <button
              type="button"
              onClick={onAddMoreFiles}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 hover:border-neutral-400 rounded-l-md transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add more files</span>
            </button>
            <button
              type="button"
              onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
              aria-label="Select file source"
              className="p-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 hover:border-neutral-400 rounded-r-md transition-colors"
            >
              <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
            </button>

            {isAddMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setIsAddMenuOpen(false)}
                />
                <div className="absolute bottom-full right-0 mb-2 w-52 bg-neutral-900 border border-neutral-700/80 rounded-xl shadow-2xl p-1.5 z-50 animate-in fade-in duration-150 text-left">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddMenuOpen(false);
                      onAddMoreFiles();
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <HardDrive className="w-4 h-4 text-[#5C6BC0]" />
                    <span>From my computer</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddMenuOpen(false);
                      onAddMoreFiles();
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <Globe className="w-4 h-4 text-[#5C6BC0]" />
                    <span>By URL</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddMenuOpen(false);
                      onAddMoreFiles();
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-[#5C6BC0]" />
                    <span>From Google Drive</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddMenuOpen(false);
                      onAddMoreFiles();
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <Archive className="w-4 h-4 text-[#5C6BC0]" />
                    <span>From Dropbox</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddMenuOpen(false);
                      onAddMoreFiles();
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-[#5C6BC0]" />
                    <span>From OneDrive</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Main Convert CTA */}
          <button
            type="button"
            disabled={isConverting || !allReady}
            onClick={onConvertAll}
            className="flex items-center justify-center gap-2 px-6 py-2 text-sm font-bold text-white bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] disabled:opacity-40 disabled:cursor-not-allowed rounded-md shadow-sm transition-all"
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

      {/* Target Format Selector Popover */}
      {currentSelectorItem && (
        <FormatSelector
          availableFormats={getAvailableTargetFormats(currentSelectorItem.sourceFormat)}
          selectedFormatId={currentSelectorItem.targetFormat}
          onSelect={(fmt) => {
            onUpdateTargetFormat(currentSelectorItem.id, fmt);
            setActiveFormatSelectorId(null);
          }}
          onClose={() => setActiveFormatSelectorId(null)}
          title={`Convert ${currentSelectorItem.sourceFormat.toUpperCase()} to:`}
        />
      )}

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
    </div>
  );
}
