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

  const currentOptionsItem = items.find((i) => i.id === activeOptionsModalId);

  return (
    <>
      {/* File Card Container matching live_cc_queue.png */}
      <div className="w-full bg-[#212529] rounded-lg border border-neutral-800 shadow-2xl overflow-visible">
        <div className="divide-y divide-neutral-800">
          {items.map((item) => {
            return (
              <div
                key={item.id}
                className="px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-colors"
              >
                {/* File Info */}
                <div className="flex items-center gap-3.5 min-w-0 md:w-5/12">
                  <div className="p-2 rounded-lg bg-[#18191d] border border-neutral-800 shrink-0">
                    {getFileCategoryIcon(item.sourceFormat)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate" title={item.name}>
                      {item.name}
                    </p>
                    <p className="text-xs text-neutral-400">
                      {formatFileSize(item.size)} &bull; {getFormatLabel(item.sourceFormat)}
                    </p>
                  </div>
                </div>

                {/* Conversion Target & Settings & Status */}
                <div className="relative flex items-center justify-between md:justify-end gap-3 flex-wrap md:flex-nowrap flex-1">
                  {/* Convert indicator */}
                  <div className="hidden sm:flex items-center gap-1.5 text-xs text-neutral-400">
                    <RefreshCw className="w-3.5 h-3.5 text-neutral-400" />
                    <span>Convert</span>
                  </div>

                  {/* Source format badge */}
                  <span className="px-2.5 py-1 text-xs font-mono font-bold uppercase rounded border border-neutral-700 bg-neutral-800 text-neutral-200">
                    {item.sourceFormat}
                  </span>

                  <span className="text-neutral-400 text-xs font-bold">&rarr;</span>

                  {/* Target format selector button */}
                  {item.targetFormat ? (
                    <button
                      type="button"
                      data-testid="queue-target-format-btn"
                      disabled={item.status === 'converting' || item.status === 'uploading'}
                      onClick={() => setActiveFormatSelectorId(activeFormatSelectorId === item.id ? null : item.id)}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono font-bold uppercase rounded border border-neutral-700 bg-[#212529] text-white hover:border-neutral-500 transition-colors"
                    >
                      <span>{item.targetFormat}</span>
                      <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="queue-target-format-btn"
                      disabled={item.status === 'converting' || item.status === 'uploading'}
                      onClick={() => setActiveFormatSelectorId(activeFormatSelectorId === item.id ? null : item.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border border-[#d9383a] text-[#d9383a] hover:bg-[#d9383a]/10 transition-colors"
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
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-neutral-700 bg-transparent text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors"
                    >
                      <Sliders className="w-3.5 h-3.5 text-neutral-400" />
                      <span>Options</span>
                    </button>
                  )}

                  {/* Progress / Status / Finished Actions */}
                  {(item.status === 'uploading' || item.status === 'converting') && (
                    <div className="flex items-center gap-2 min-w-[120px]">
                      <Loader2 className="w-3.5 h-3.5 text-[#d9383a] animate-spin" />
                      <div className="w-full bg-neutral-700 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-[#d9383a] h-full transition-all duration-300 rounded-full"
                          style={{ width: `${Math.max(15, item.progress)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {item.status === 'completed' && item.resultUrl && (
                    <a
                      href={item.resultUrl}
                      download={`converted_${item.name.replace(/\.[^/.]+$/, '')}.${item.targetFormat}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded shadow-sm transition-colors"
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
                    className="p-1.5 text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition-colors"
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

      {/* Fixed Sticky Footer Bar matching live_cc_queue.png & live_cc_queue_with_format.png */}
      <div className="fixed bottom-0 inset-x-0 h-16 bg-[#1f2226] border-t border-neutral-800 z-40 px-6 flex items-center justify-between">
        <div className="max-w-8xl mx-auto w-full flex items-center justify-between">
          {/* Left Side Status */}
          <div className="flex items-center gap-2 text-sm text-neutral-400">
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
          <div className="flex items-center gap-3">
            {/* Download all zip if multiple completed */}
            {completedCount > 1 && (
              <button
                type="button"
                onClick={onDownloadAllZip}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-[#d9383a] bg-[#d9383a]/10 hover:bg-[#d9383a]/20 rounded transition-colors"
              >
                <Package className="w-3.5 h-3.5" />
                <span>Download All (ZIP)</span>
              </button>
            )}

            {/* Add more files split button */}
            <div className="relative inline-flex shadow-sm">
              <button
                type="button"
                onClick={onAddMoreFiles}
                className="bg-[#212529] hover:bg-neutral-700 text-white border border-neutral-700 rounded-l text-sm font-medium flex items-center gap-2 px-3.5 py-2 transition-colors"
              >
                <FilePlus className="w-4 h-4 text-neutral-400" />
                <span>Add more files</span>
              </button>
              <button
                type="button"
                onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
                aria-label="Select file source"
                className="bg-[#212529] hover:bg-neutral-700 text-white border-y border-r border-neutral-700 rounded-r text-sm font-medium p-2 transition-colors"
              >
                <ChevronDown className="w-4 h-4 text-neutral-400" />
              </button>

              {isAddMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setIsAddMenuOpen(false)}
                  />
                  <div className="absolute bottom-full right-0 mb-2 w-56 bg-[#212529] border border-neutral-700/80 rounded-xl shadow-2xl p-1.5 z-50 animate-in fade-in duration-150 text-left">
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                    >
                      <HardDrive className="w-4 h-4 text-neutral-400" />
                      <span>From my computer</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                    >
                      <Globe className="w-4 h-4 text-neutral-400" />
                      <span>By URL</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                    >
                      <FolderOpen className="w-4 h-4 text-neutral-400" />
                      <span>From Google Drive</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                    >
                      <Archive className="w-4 h-4 text-neutral-400" />
                      <span>From Dropbox</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddMenuOpen(false);
                        onAddMoreFiles();
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                    >
                      <FolderOpen className="w-4 h-4 text-neutral-400" />
                      <span>From OneDrive</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Main Convert CTA button: [ 🔄 Convert ] */}
            <button
              type="button"
              disabled={isConverting || !allReady}
              onClick={onConvertAll}
              className="bg-[#d9383a] hover:bg-[#c93234] text-white px-5 py-2.5 rounded font-medium flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
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
