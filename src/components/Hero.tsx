'use client';

import React, { useState, useRef } from 'react';
import {
  UploadCloud,
  ChevronDown,
  Globe,
  HardDrive,
  Maximize2,
  Minimize2,
  Plus,
} from 'lucide-react';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
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
  const [isForceExpanded, setIsForceExpanded] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isCollapsed = hasActiveQueue && !isForceExpanded;

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

  const popularShortcuts = [
    { src: 'pdf', tgt: 'docx', label: 'PDF to Word' },
    { src: 'mp4', tgt: 'mp3', label: 'MP4 to MP3' },
    { src: 'docx', tgt: 'pdf', label: 'DOCX to PDF' },
    { src: 'png', tgt: 'webp', label: 'PNG to WebP' },
    { src: 'xlsx', tgt: 'csv', label: 'XLSX to CSV' },
    { src: 'epub', tgt: 'pdf', label: 'EPUB to PDF' },
    { src: 'wav', tgt: 'mp3', label: 'WAV to MP3' },
    { src: 'webm', tgt: 'mp4', label: 'WEBM to MP4' },
  ];

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      onChange={handleFileChange}
      className="hidden"
      id="main-file-input"
    />
  );

  // 1. COLLAPSED VIEW (When files are in queue)
  if (isCollapsed) {
    return (
      <section className="bg-neutral-scaffold/70 dark:bg-dark-surface/60 border-b border-neutral-border dark:border-dark-border py-4 transition-all">
        {fileInput}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-wrap items-center justify-between gap-3">
          {/* Quick preset indicator */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink-muted">Default preset:</span>
            <button
              type="button"
              onClick={() => setIsSourceSelectorOpen(true)}
              className="px-2.5 py-1 text-xs font-bold uppercase rounded-lg bg-white dark:bg-dark-elevated border border-neutral-border dark:border-dark-border hover:border-brand-500 text-brand-950 dark:text-dark-text flex items-center gap-1 transition-colors"
            >
              <span>{sourceFormat}</span>
              <ChevronDown className="w-3 h-3 text-ink-muted" />
            </button>
            <span className="text-xs font-semibold text-ink-muted">to</span>
            <button
              type="button"
              onClick={() => setIsTargetSelectorOpen(true)}
              className="px-2.5 py-1 text-xs font-bold uppercase rounded-lg bg-white dark:bg-dark-elevated border border-neutral-border dark:border-dark-border hover:border-brand-500 text-brand-950 dark:text-dark-text flex items-center gap-1 transition-colors"
            >
              <span>{targetFormat}</span>
              <ChevronDown className="w-3 h-3 text-ink-muted" />
            </button>
          </div>

          {/* Add More Files button & Expand toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-brand-700 hover:bg-brand-800 rounded-lg shadow-sm transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add More Files</span>
            </button>

            <button
              type="button"
              onClick={() => setIsForceExpanded(true)}
              title="Expand converter description"
              className="p-1.5 text-ink-muted hover:text-brand-700 dark:hover:text-brand-300 rounded-lg transition-colors"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
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
            availableFormats={getAvailableTargetFormats(sourceFormat)}
            selectedFormatId={targetFormat}
            onSelect={(fmt) => setTargetFormat(fmt)}
            onClose={() => setIsTargetSelectorOpen(false)}
            title={`Convert ${sourceFormat.toUpperCase()} to:`}
          />
        )}
      </section>
    );
  }

  // 2. EXPANDED / DEFAULT HERO VIEW
  return (
    <section className="relative pt-10 pb-16 md:pt-16 md:pb-20">
      {fileInput}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
        {hasActiveQueue && (
          <div className="flex justify-end mb-2">
            <button
              type="button"
              onClick={() => setIsForceExpanded(false)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>Collapse Hero</span>
            </button>
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight text-brand-950 dark:text-white mb-4">
          File Converter
        </h1>

        {/* Subtitle */}
        <p className="text-xs sm:text-sm text-ink-secondary dark:text-dark-muted max-w-2xl mx-auto mb-8 leading-relaxed">
          Convert audio, video, documents, spreadsheets, ebooks, presentations, and archives online.
          Supports 200+ formats across 9 domains with 100% in-memory real-time zero data retention.
        </p>

        {/* Converter Presets Widget */}
        <div className="inline-flex flex-wrap items-center justify-center gap-2 p-1.5 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm mb-8">
          <span className="text-xs font-semibold text-ink-muted pl-2">convert</span>

          {/* Source format trigger */}
          <button
            type="button"
            onClick={() => setIsSourceSelectorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border hover:border-brand-500 text-brand-950 dark:text-dark-text text-xs font-bold uppercase transition-colors"
          >
            <span>{sourceFormat}</span>
            <ChevronDown className="w-3 h-3 text-ink-muted" />
          </button>

          <span className="text-xs font-semibold text-ink-muted">to</span>

          {/* Target format trigger */}
          <button
            type="button"
            onClick={() => setIsTargetSelectorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border hover:border-brand-500 text-brand-950 dark:text-dark-text text-xs font-bold uppercase transition-colors"
          >
            <span>{targetFormat}</span>
            <ChevronDown className="w-3 h-3 text-ink-muted" />
          </button>
        </div>

        {/* CTA Dropzone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative max-w-lg mx-auto rounded-2xl border-2 border-dashed p-8 transition-all ${
            isDragOver
              ? 'border-brand-700 bg-brand-50/60 dark:bg-dark-elevated/80 scale-[1.01]'
              : 'border-neutral-border dark:border-dark-border bg-white/80 dark:bg-dark-surface/80 hover:border-brand-500 shadow-sm'
          }`}
        >
          <div className="flex flex-col items-center justify-center">
            {/* Split CTA Button */}
            <div className="relative inline-flex shadow-sm rounded-xl overflow-visible mb-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2.5 px-6 py-3 bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white font-bold text-sm rounded-l-xl transition-all"
              >
                <UploadCloud className="w-4 h-4" />
                <span>Select File</span>
              </button>

              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                onBlur={() => setTimeout(() => setIsDropdownOpen(false), 200)}
                className="px-3 bg-brand-800 hover:bg-brand-900 text-white border-l border-brand-600 rounded-r-xl transition-all"
                aria-label="Upload options"
              >
                <ChevronDown className={`w-4 h-4 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Upload Options Menu */}
              {isDropdownOpen && (
                <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-dark-surface rounded-xl shadow-xl border border-neutral-border dark:border-dark-border p-1.5 z-50 animate-in fade-in duration-150 text-left">
                  <button
                    type="button"
                    onClick={() => {
                      setIsDropdownOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-brand-950 dark:text-dark-text hover:bg-neutral-scaffold dark:hover:bg-dark-elevated rounded-lg transition-colors"
                  >
                    <HardDrive className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" />
                    <span>From my Computer</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsDropdownOpen(false);
                      setIsUrlModalOpen(true);
                    }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-brand-950 dark:text-dark-text hover:bg-neutral-scaffold dark:hover:bg-dark-elevated rounded-lg transition-colors"
                  >
                    <Globe className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" />
                    <span>By URL</span>
                  </button>
                </div>
              )}
            </div>

            <p className="text-[11px] text-ink-muted">or drop files here (up to 100 MB per file, zero data retention)</p>
          </div>
        </div>

        {/* Popular Presets Quick Bar */}
        <div className="flex flex-wrap items-center justify-center gap-2 mt-6">
          {popularShortcuts.map((sc, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                setSourceFormat(sc.src);
                setTargetFormat(sc.tgt);
                fileInputRef.current?.click();
              }}
              className="px-2.5 py-1 text-[11px] font-semibold text-ink-secondary dark:text-dark-muted bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border hover:border-brand-500 rounded-lg transition-colors"
            >
              {sc.label}
            </button>
          ))}
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
          availableFormats={getAvailableTargetFormats(sourceFormat)}
          selectedFormatId={targetFormat}
          onSelect={(fmt) => setTargetFormat(fmt)}
          onClose={() => setIsTargetSelectorOpen(false)}
          title={`Convert ${sourceFormat.toUpperCase()} to:`}
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
