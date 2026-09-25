'use client';

import React, { useState, useRef } from 'react';
import {
  UploadCloud,
  ChevronDown,
  Globe,
  HardDrive,
  FolderOpen,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import FormatSelector from './FormatSelector';
import UrlUploadModal from './UrlUploadModal';

interface HeroProps {
  onFilesSelected: (files: File[], defaultTarget?: string) => void;
  hasActiveQueue: boolean;
}

export default function Hero({ onFilesSelected, hasActiveQueue }: HeroProps) {
  const [sourceFormat, setSourceFormat] = useState('png');
  const [targetFormat, setTargetFormat] = useState('pdf');
  const [isSourceSelectorOpen, setIsSourceSelectorOpen] = useState(false);
  const [isTargetSelectorOpen, setIsTargetSelectorOpen] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      onFilesSelected(files, targetFormat);
      e.target.value = '';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      onFilesSelected(files, targetFormat);
    }
  };

  return (
    <section className="relative pt-12 pb-16 md:pt-20 md:pb-24 overflow-hidden">
      {/* Background lavender glow circles */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-brand-200/40 dark:bg-brand-900/10 rounded-full blur-3xl pointer-events-none -z-10" />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-100 dark:bg-brand-950/80 border border-brand-300 dark:border-brand-800 text-brand-700 dark:text-brand-300 text-xs font-semibold mb-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Universal High-Performance Conversion Engine</span>
        </div>

        {/* Title */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-brand-950 dark:text-white mb-6">
          File Converter
        </h1>

        {/* Subtitle */}
        <p className="text-base sm:text-lg text-ink-secondary dark:text-dark-muted max-w-2xl mx-auto mb-10 leading-relaxed">
          Convert your files to any format. EasyConvert supports 200+ formats across documents, images, spreadsheets,
          and archives — straight from your browser with zero data retention.
        </p>

        {/* Interactive Converter Presets Widget */}
        <div className="inline-flex flex-wrap items-center justify-center gap-2.5 p-2 rounded-2xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-lg mb-10">
          <span className="text-sm font-semibold text-ink-muted pl-3">convert</span>

          {/* Source format trigger */}
          <button
            type="button"
            onClick={() => setIsSourceSelectorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-brand-50 dark:bg-dark-elevated border border-brand-200 dark:border-brand-800 hover:border-brand-600 text-brand-950 dark:text-dark-text text-sm font-bold uppercase transition-colors"
          >
            <span>{sourceFormat}</span>
            <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
          </button>

          <span className="text-sm font-semibold text-ink-muted">to</span>

          {/* Target format trigger */}
          <button
            type="button"
            onClick={() => setIsTargetSelectorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-brand-50 dark:bg-dark-elevated border border-brand-200 dark:border-brand-800 hover:border-brand-600 text-brand-950 dark:text-dark-text text-sm font-bold uppercase transition-colors"
          >
            <span>{targetFormat}</span>
            <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
          </button>
        </div>

        {/* Big CTA Select File Dropdown Zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative max-w-xl mx-auto rounded-3xl border-2 border-dashed p-8 transition-all ${
            isDragOver
              ? 'border-brand-700 bg-brand-100/50 dark:bg-brand-950/40 scale-102 shadow-xl shadow-brand-500/10'
              : 'border-brand-300 dark:border-brand-900 bg-white/70 dark:bg-dark-surface/70 hover:border-brand-500 shadow-md'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
            id="main-file-input"
          />

          <div className="flex flex-col items-center justify-center">
            {/* Split CTA Button */}
            <div className="relative inline-flex shadow-xl shadow-brand-700/20 rounded-2xl overflow-visible mb-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-3 px-8 py-4 bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white font-bold text-base rounded-l-2xl transition-all"
              >
                <UploadCloud className="w-5 h-5" />
                <span>Select File</span>
              </button>

              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                onBlur={() => setTimeout(() => setIsDropdownOpen(false), 200)}
                className="px-3.5 bg-brand-800 hover:bg-brand-900 active:bg-brand-950 text-white border-l border-brand-600 rounded-r-2xl transition-all"
                aria-label="Upload options"
              >
                <ChevronDown className={`w-5 h-5 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Upload Options Menu */}
              {isDropdownOpen && (
                <div className="absolute top-full right-0 mt-2 w-56 bg-white dark:bg-dark-surface rounded-xl shadow-2xl border border-neutral-border dark:border-dark-border p-2 z-50 animate-in fade-in duration-150 text-left">
                  <button
                    type="button"
                    onClick={() => {
                      setIsDropdownOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="flex items-center gap-3 w-full px-3 py-2 text-xs font-semibold text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated rounded-lg transition-colors"
                  >
                    <HardDrive className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                    <span>From my Computer</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsDropdownOpen(false);
                      setIsUrlModalOpen(true);
                    }}
                    className="flex items-center gap-3 w-full px-3 py-2 text-xs font-semibold text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated rounded-lg transition-colors"
                  >
                    <Globe className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                    <span>By URL</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsDropdownOpen(false);
                      alert('Cloud storage integration is ready for OAuth credentials.');
                    }}
                    className="flex items-center gap-3 w-full px-3 py-2 text-xs font-semibold text-brand-950 dark:text-dark-text hover:bg-brand-50 dark:hover:bg-dark-elevated rounded-lg transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                    <span>From Google Drive</span>
                  </button>
                </div>
              )}
            </div>

            <p className="text-xs text-ink-muted">or drop files here (up to 100 MB per file)</p>
          </div>
        </div>
      </div>

      {/* Source Selector Modal */}
      {isSourceSelectorOpen && (
        <FormatSelector
          selectedFormatId={sourceFormat}
          onSelect={(fmt) => {
            setSourceFormat(fmt);
            const def = FORMAT_REGISTRY[fmt];
            if (def && def.targetFormats.length > 0 && !def.targetFormats.includes(targetFormat)) {
              setTargetFormat(def.targetFormats[0]);
            }
          }}
          onClose={() => setIsSourceSelectorOpen(false)}
          title="Convert from format:"
        />
      )}

      {/* Target Selector Modal */}
      {isTargetSelectorOpen && (
        <FormatSelector
          selectedFormatId={targetFormat}
          onSelect={(fmt) => setTargetFormat(fmt)}
          onClose={() => setIsTargetSelectorOpen(false)}
          title="Convert to format:"
        />
      )}

      {/* URL Modal */}
      {isUrlModalOpen && (
        <UrlUploadModal
          onAddFile={(file) => onFilesSelected([file], targetFormat)}
          onClose={() => setIsUrlModalOpen(false)}
        />
      )}
    </section>
  );
}
