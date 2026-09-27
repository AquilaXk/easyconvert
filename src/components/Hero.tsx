'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronDown,
  Globe,
  HardDrive,
  FolderOpen,
  Archive,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';
import { FORMAT_REGISTRY } from '@/lib/registry';
import UrlImportModal from './UrlImportModal';
import { BrandIcon } from './BrandLogo';

interface HeroProps {
  onFilesSelected: (files: File[], defaultTarget?: string) => void;
  hasActiveQueue: boolean;
  activeSourceFormat?: string;
  activeTargetFormat?: string;
  categoryTitle?: string;
  categoryDescription?: string;
}

export default function Hero({
  onFilesSelected,
  hasActiveQueue,
  activeSourceFormat,
  activeTargetFormat,
  categoryTitle,
  categoryDescription,
}: HeroProps) {
  const [sourceFormat, setSourceFormat] = useState(activeSourceFormat || 'pdf');
  const [targetFormat, setTargetFormat] = useState(activeTargetFormat || 'docx');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetFormatRef = useRef(targetFormat);

  useEffect(() => {
    targetFormatRef.current = targetFormat;
  }, [targetFormat]);

  useEffect(() => {
    if (activeSourceFormat) setSourceFormat(activeSourceFormat);
  }, [activeSourceFormat]);

  useEffect(() => {
    if (activeTargetFormat) {
      setTargetFormat(activeTargetFormat);
      targetFormatRef.current = activeTargetFormat;
    }
  }, [activeTargetFormat]);

  const getEffectiveTargetFormat = (chosen?: string, fallback?: string): string | undefined => {
    if (chosen && chosen.toLowerCase() !== 'any') {
      return chosen.toLowerCase();
    }
    if (fallback && fallback.toLowerCase() !== 'any') {
      return fallback.toLowerCase();
    }
    return undefined;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      const chosen = targetFormatRef.current;
      const effectiveTarget = getEffectiveTargetFormat(chosen, activeTargetFormat);
      onFilesSelected(files, effectiveTarget);
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
      const chosen = targetFormatRef.current;
      const effectiveTarget = getEffectiveTargetFormat(chosen, activeTargetFormat);
      onFilesSelected(files, effectiveTarget);
    }
  };

  const getHeroTitle = () => {
    if (categoryTitle) return categoryTitle;
    if (activeSourceFormat && (!targetFormat || targetFormat.toLowerCase() === 'any')) {
      return `${activeSourceFormat.toUpperCase()} Converter`;
    }
    if (activeSourceFormat && activeTargetFormat && activeTargetFormat.toLowerCase() !== 'any') {
      const srcName = activeSourceFormat.toUpperCase();
      const tgtName = activeTargetFormat.toUpperCase();
      return `${srcName} to ${tgtName} Converter`;
    }
    if (!hasActiveQueue && !activeSourceFormat) return 'File Converter';
    if (sourceFormat && targetFormat && targetFormat.toLowerCase() !== 'any') {
      const srcName = sourceFormat.toUpperCase();
      const tgtName = targetFormat.toUpperCase();
      if (srcName === 'PDF' && tgtName === 'DOCX') return 'PDF to Word Converter';
      return `${srcName} to ${tgtName} Converter`;
    }
    if (sourceFormat) {
      return `${sourceFormat.toUpperCase()} Converter`;
    }
    return 'File Converter';
  };

  const getHeroSubtitle = () => {
    if (categoryDescription) return categoryDescription;
    if (activeSourceFormat && (!targetFormat || targetFormat.toLowerCase() === 'any')) {
      return `EasyConvert is a high-fidelity online document and media converter. Supporting 292 formats directly in your browser with zero server data retention.`;
    }
    if (!hasActiveQueue && !activeSourceFormat) {
      return 'Convert your files to any format online and free. Fast, client-side conversion for 292 formats with zero server data retention.';
    }
    return `EasyConvert offers advanced, high-fidelity ${sourceFormat.toUpperCase()} to ${targetFormat.toUpperCase()} conversions. Preserves layouts, typography, and structure straight from your browser.`;
  };

  const popularPresets = [
    { label: 'PDF to Word', src: 'pdf', tgt: 'docx' },
    { label: 'Word to PDF', src: 'docx', tgt: 'pdf' },
    { label: 'Image to WebP', src: 'png', tgt: 'webp' },
    { label: 'Video to MP3', src: 'mp4', tgt: 'mp3' },
    { label: 'HEIC to JPG', src: 'heic', tgt: 'jpg' },
    { label: 'EPUB to PDF', src: 'epub', tgt: 'pdf' },
  ];

  return (
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileChange}
        className="hidden"
        id="main-file-input"
      />

      {/* Spacious, Human-Crafted Hero Section */}
      <section
        className={`relative overflow-hidden bg-neutral-scaffold dark:bg-dark-scaffold transition-colors ${
          hasActiveQueue ? 'pt-8 pb-4' : 'pt-12 pb-16 sm:pt-16 sm:pb-24'
        }`}
      >
        {/* Soft luminous ambient backdrop */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_0%,rgba(92,107,192,0.09),transparent_75%)] pointer-events-none"
        />

        <div className="relative mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 text-center">
          {/* Brand Kicker Badge */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-brand-500/10 dark:bg-brand-500/15 border border-brand-400/30 text-brand-700 dark:text-brand-300 mb-4 shadow-sm">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Client-Side Engine • 292 Formats Supported • Zero Server Storage</span>
          </div>

          {/* Clean Hero Title */}
          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black tracking-tight text-brand-950 dark:text-white leading-[1.12]">
            {getHeroTitle()}
          </h1>

          {/* Subtitle */}
          <p className="mt-4 text-base sm:text-lg sm:leading-relaxed text-ink-secondary dark:text-neutral-300 max-w-2xl mx-auto">
            {getHeroSubtitle()}
          </p>

          {/* Converter Dropzone & Massive CTA Box (Idle State) */}
          {!hasActiveQueue && (
            <>
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`relative mx-auto mt-8 sm:mt-10 w-full max-w-3xl rounded-3xl border-2 border-dashed p-8 sm:p-12 text-center transition-all duration-300 ease-out shadow-xl ${
                  isDragOver
                    ? 'border-brand-700 border-solid ring-4 ring-brand-700/20 bg-brand-50/70 dark:bg-brand-950/40 scale-[1.01]'
                    : 'bg-white border-neutral-border hover:border-brand-400 shadow-brand-700/5 dark:bg-[#181D30] dark:border-[#2C375A] dark:hover:border-brand-500/50 dark:shadow-black/50'
                }`}
              >
                {/* Official Brand Vector Mark on Tactile Squircle */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Select files to convert"
                  className="group/icon relative inline-flex items-center justify-center p-4 rounded-2xl bg-brand-50 dark:bg-brand-900/40 border border-brand-200 dark:border-brand-700/30 shadow-md shadow-brand-700/10 hover:shadow-lg hover:shadow-brand-700/20 transition-all duration-200 hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 cursor-pointer mx-auto mb-5 text-brand-700 dark:text-brand-300"
                >
                  <BrandIcon size={44} />
                </button>

                {/* Main Instruction */}
                <div className="space-y-1 mb-6">
                  <h2 className="text-xl font-bold tracking-tight text-brand-950 dark:text-white sm:text-2xl">
                    Choose Files to Convert
                  </h2>
                  <p className="text-sm text-ink-muted dark:text-neutral-400 sm:text-base">
                    Drop files here, or paste from clipboard
                  </p>
                </div>

                {/* Massive Tactile Choose Files Split Button */}
                <div className="inline-flex relative z-10">
                  <div className="relative inline-flex -space-x-px shadow-lg shadow-brand-700/25 hover:shadow-brand-700/40 rounded-2xl overflow-visible transition-shadow">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-l-2xl font-bold inline-flex items-center transition-all px-8 sm:px-10 py-4 text-base sm:text-lg gap-3 text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-brand-700"
                    >
                      <svg className="size-5 fill-current shrink-0" viewBox="0 0 384 512">
                        <path d="M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM192 240c-13.3 0-24 10.7-24 24l0 48-48 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l48 0 0 48c0 13.3 10.7 24 24 24s24-10.7 24-24l0-48 48 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-48 0 0-48c0-13.3-10.7-24-24-24z" />
                      </svg>
                      <span>Choose Files</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                      aria-label="Select file source"
                      className="rounded-r-2xl font-bold inline-flex items-center transition-all text-base border-l border-white/20 text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 px-4 py-4 outline-none cursor-pointer"
                    >
                      <ChevronDown
                        className={`size-5 transition-transform duration-200 ${
                          isDropdownOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>

                    {/* Source Selector Dropdown */}
                    {isDropdownOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setIsDropdownOpen(false)}
                        />
                        <div className="absolute top-full right-0 mt-2 w-60 bg-white dark:bg-[#161B2E] rounded-2xl shadow-2xl border border-neutral-border dark:border-[#283252] p-1.5 z-50 animate-in fade-in duration-150 text-left">
                          <button
                            type="button"
                            onClick={() => {
                              setIsDropdownOpen(false);
                              fileInputRef.current?.click();
                            }}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm font-medium text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                          >
                            <HardDrive className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                            <span>From my computer</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setIsDropdownOpen(false);
                              setIsUrlModalOpen(true);
                            }}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm font-medium text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                          >
                            <Globe className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                            <span>By URL</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setIsDropdownOpen(false);
                              fileInputRef.current?.click();
                            }}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm font-medium text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                          >
                            <FolderOpen className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                            <span>From Google Drive</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setIsDropdownOpen(false);
                              fileInputRef.current?.click();
                            }}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm font-medium text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                          >
                            <Archive className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                            <span>From Dropbox</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setIsDropdownOpen(false);
                              fileInputRef.current?.click();
                            }}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm font-medium text-brand-950 dark:text-neutral-200 hover:bg-brand-50 dark:hover:bg-brand-700/20 hover:text-brand-700 dark:hover:text-white rounded-xl transition-colors cursor-pointer"
                          >
                            <FolderOpen className="w-4 h-4 text-ink-muted dark:text-neutral-400" />
                            <span>From OneDrive</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Trust & Architecture Badges */}
                <div className="mt-8 flex items-center justify-center flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-ink-secondary dark:text-neutral-400 pt-4 border-t border-neutral-100 dark:border-[#242C48]">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                    100% Free &amp; Unlimited
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-brand-700" />
                    Max 1 GB File Size
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500" />
                    Zero Cloud Retention
                  </span>
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="size-3.5 text-brand-700 dark:text-brand-400" />
                    292 Formats Supported
                  </span>
                </div>
              </div>

              {/* Popular Workflows Quick Presets */}
              <div className="max-w-3xl mx-auto mt-6 px-2">
                <div className="flex items-center justify-center flex-wrap gap-2 text-xs">
                  <span className="text-[11px] font-mono font-bold tracking-wider uppercase text-ink-muted dark:text-neutral-400 mr-1 flex items-center gap-1">
                    <Sparkles className="size-3 text-brand-700 dark:text-brand-400 shrink-0" />
                    <span>POPULAR:</span>
                  </span>
                  {popularPresets.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        setSourceFormat(preset.src);
                        setTargetFormat(preset.tgt);
                        targetFormatRef.current = preset.tgt;
                        fileInputRef.current?.click();
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-xl bg-white dark:bg-white/[0.04] text-brand-950 dark:text-neutral-300 hover:text-brand-700 dark:hover:text-white border border-neutral-border dark:border-white/10 hover:border-brand-500 hover:bg-brand-50 dark:hover:bg-brand-700/20 shadow-sm transition-all cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* URL Import Modal */}
      {isUrlModalOpen && (
        <UrlImportModal
          isOpen={isUrlModalOpen}
          onAddFile={(file) =>
            onFilesSelected([file], targetFormat === 'any' ? 'mp3' : targetFormat)
          }
          onClose={() => setIsUrlModalOpen(false)}
        />
      )}
    </>
  );
}
