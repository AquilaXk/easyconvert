'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronDown,
  Globe,
  HardDrive,
  RefreshCw,
  FileText,
  FileImage,
  Music,
  Video,
  Database,
  Archive,
  BookOpen,
  FilePlus2,
  FolderOpen,
} from 'lucide-react';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
import FormatSelector from './FormatSelector';
import UrlImportModal from './UrlImportModal';

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
  const [isSourceSelectorOpen, setIsSourceSelectorOpen] = useState(false);
  const [isTargetSelectorOpen, setIsTargetSelectorOpen] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeSourceFormat) setSourceFormat(activeSourceFormat);
  }, [activeSourceFormat]);

  useEffect(() => {
    if (activeTargetFormat) setTargetFormat(activeTargetFormat);
  }, [activeTargetFormat]);

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

  const getFormatIcon = (fmt: string) => {
    const def = FORMAT_REGISTRY[fmt?.toLowerCase()];
    const cat = def?.category;
    switch (cat) {
      case 'audio':
        return <Music className="w-8 h-8 text-neutral-300" />;
      case 'video':
        return <Video className="w-8 h-8 text-neutral-300" />;
      case 'image':
        return <FileImage className="w-8 h-8 text-neutral-300" />;
      case 'spreadsheet':
      case 'data':
        return <Database className="w-8 h-8 text-neutral-300" />;
      case 'archive':
        return <Archive className="w-8 h-8 text-neutral-300" />;
      case 'ebook':
        return <BookOpen className="w-8 h-8 text-neutral-300" />;
      default:
        return <FileText className="w-8 h-8 text-neutral-300" />;
    }
  };

  // Dynamic titles matching live CloudConvert behavior
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
    if (!hasActiveQueue && !activeSourceFormat) return 'Convert Any File';
    if (sourceFormat && targetFormat && targetFormat.toLowerCase() !== 'any') {
      const srcName = sourceFormat.toUpperCase();
      const tgtName = targetFormat.toUpperCase();
      if (srcName === 'PDF' && tgtName === 'DOCX') return 'PDF to Word Converter';
      return `${srcName} to ${tgtName} Converter`;
    }
    if (sourceFormat) {
      return `${sourceFormat.toUpperCase()} Converter`;
    }
    return 'Convert Any File';
  };

  const getHeroSubtitle = () => {
    if (categoryDescription) return categoryDescription;
    if (activeSourceFormat && (!targetFormat || targetFormat.toLowerCase() === 'any')) {
      return `EasyConvert is an online document converter. Amongst many others, we support PDF, DOCX, PPTX, XLSX. Thanks to our advanced conversion technology the quality of the output will be as good as if the file was saved through the latest Microsoft Office suite.`;
    }
    if (!hasActiveQueue && !activeSourceFormat) {
      return 'Drop a file and pick what to turn it into. EasyConvert handles 200+ formats across documents, images, audio, video, archives and more — straight from your browser.';
    }
    return `EasyConvert offers advanced, high-fidelity ${sourceFormat.toUpperCase()} to ${targetFormat.toUpperCase()} conversions. We preserve layouts, formatting, and tables straight from your browser.`;
  };

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

      {/* 1. DARK HERO SECTION */}
      <section className="relative overflow-hidden bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 pt-16 pb-44 px-4 sm:px-6 lg:px-8 text-white">
        {/* Subtle grid pattern background */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3Cpattern id='g' width='60' height='60' patternUnits='userSpaceOnUse'%3E%3Cpath d='M 60 0 L 0 0 0 60' fill='none' stroke='white' stroke-width='0.5'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23g)'/%3E%3C/svg%3E")`,
          }}
        />

        {/* Ambient lavender radial gradient */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_70%_-10%,rgba(92,107,192,0.25),transparent)] pointer-events-none"
        />

        <div className="relative mx-auto max-w-7xl">
          <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
            {/* Left Column: Dynamic Heading and Subtitle */}
            <div className="text-center lg:text-left">
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-tight">
                {getHeroTitle()}
              </h1>
              <p className="mt-5 text-base sm:text-lg sm:leading-relaxed text-neutral-300 max-w-xl">
                {getHeroSubtitle()}
              </p>
            </div>

            {/* Right Column: Signature 2-Card Interactive Widget */}
            <div className="relative flex justify-center lg:justify-end">
              <div className="relative flex w-full max-w-md items-center justify-center">
                {/* Orbit rings */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute size-[280px] sm:size-[320px] rounded-full border border-white/[0.06]"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute size-[200px] sm:size-[230px] rounded-full border border-white/[0.08]"
                />
                {/* Lavender glow behind target */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute size-40 rounded-full bg-[#5C6BC0]/20 blur-3xl"
                />

                {/* The Two Cards Widget */}
                <div className="relative z-10 flex items-center gap-3 sm:gap-4">
                  {/* Left Card: Source Format */}
                  <button
                    type="button"
                    onClick={() => setIsSourceSelectorOpen(true)}
                    className="group relative flex h-[6.75rem] w-24 sm:h-[7.5rem] sm:w-28 cursor-pointer items-center justify-center rounded-[0.85rem] border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-md transition duration-300 ease-out hover:-translate-y-0.5 hover:border-white/20 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_12px_30px_rgba(0,0,0,0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5C6BC0]/60 active:translate-y-0"
                    aria-label={`Input format: ${sourceFormat.toUpperCase()}. Click to change.`}
                  >
                    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 px-2">
                      <div className="transition-transform duration-300 group-hover:scale-110">
                        {getFormatIcon(sourceFormat)}
                      </div>
                      <span className="max-w-full truncate text-xs sm:text-sm font-bold tracking-wider text-neutral-100 uppercase">
                        {sourceFormat}
                      </span>
                    </div>
                    <ChevronDown className="absolute right-2 bottom-1.5 size-2.5 text-neutral-400 transition-colors group-hover:text-neutral-200" />
                  </button>

                  {/* Center Circle: TO Indicator */}
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex items-center">
                      <div className="relative h-px w-5 sm:w-7 overflow-hidden bg-gradient-to-r from-neutral-700 to-[#5C6BC0]/70" aria-hidden="true" />
                      <button
                        type="button"
                        onClick={() => {
                          if (targetFormat.toLowerCase() === 'any') return;
                          const tmp = sourceFormat;
                          setSourceFormat(targetFormat);
                          setTargetFormat(tmp);
                        }}
                        disabled={targetFormat.toLowerCase() === 'any'}
                        title={targetFormat.toLowerCase() === 'any' ? 'Select specific output format to swap' : 'Swap formats'}
                        className={`group/op relative mx-1 flex size-9 sm:size-10 items-center justify-center rounded-full border backdrop-blur-sm transition duration-300 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5C6BC0]/60 ${
                          targetFormat.toLowerCase() === 'any'
                            ? 'opacity-40 cursor-not-allowed border-neutral-700 bg-neutral-800/40 text-neutral-500'
                            : 'cursor-pointer border-[#5C6BC0]/40 bg-[#5C6BC0]/15 hover:scale-110 hover:border-[#5C6BC0]/70 hover:bg-[#5C6BC0]/25 text-[#5C6BC0]'
                        }`}
                        aria-label="Swap formats"
                      >
                        <RefreshCw className={`size-4 transition-transform duration-300 ${targetFormat.toLowerCase() !== 'any' ? 'group-hover/op:rotate-180' : ''}`} />
                        {targetFormat.toLowerCase() !== 'any' && (
                          <div className="pointer-events-none absolute inset-0 animate-ping rounded-full ring-1 ring-[#5C6BC0]/20" aria-hidden="true" />
                        )}
                      </button>
                      <div className="relative h-px w-5 sm:w-7 overflow-hidden bg-gradient-to-r from-[#5C6BC0]/70 to-neutral-700" aria-hidden="true" />
                    </div>
                    <span className="text-[0.65rem] font-medium uppercase tracking-[0.25em] text-neutral-400">
                      to
                    </span>
                  </div>

                  {/* Right Card: Target Format (Highlighted with Lavender Glow) */}
                  <button
                    type="button"
                    onClick={() => setIsTargetSelectorOpen(true)}
                    className="group relative flex h-[6.75rem] w-24 sm:h-[7.5rem] sm:w-28 cursor-pointer items-center justify-center rounded-[0.85rem] border border-[#5C6BC0]/40 bg-gradient-to-br from-white/[0.07] to-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_32px_rgba(92,107,192,0.25)] backdrop-blur-md transition duration-300 ease-out hover:-translate-y-0.5 hover:border-[#5C6BC0]/65 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_38px_rgba(92,107,192,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5C6BC0]/60 active:translate-y-0"
                    aria-label={`Output format: ${targetFormat.toUpperCase()}. Click to change.`}
                  >
                    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 px-2">
                      <div className="transition-transform duration-300 group-hover:scale-110">
                        {getFormatIcon(targetFormat)}
                      </div>
                      <span className="max-w-full truncate text-xs sm:text-sm font-bold tracking-wider text-neutral-100 uppercase">
                        {targetFormat}
                      </span>
                    </div>
                    <ChevronDown className="absolute right-2 bottom-1.5 size-2.5 text-[#5C6BC0] transition-colors group-hover:text-white" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. FLOATING DROPZONE CARD (Straddling Dark and Light Boundary) */}
      {!hasActiveQueue && (
        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col px-4 pb-6 sm:px-6 -mt-32">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`group/dropzone relative mx-auto mb-10 w-full max-w-2xl overflow-visible rounded-3xl border bg-white px-6 py-8 text-center shadow-xl ring-1 transition-all duration-300 ease-out sm:px-10 sm:py-10 dark:bg-neutral-900 ${
              isDragOver
                ? 'border-[#5C6BC0] ring-[#5C6BC0]/30 scale-[1.01]'
                : 'border-neutral-200/80 ring-black/[0.04] shadow-neutral-950/10 hover:border-neutral-300 hover:shadow-neutral-950/15 dark:border-white/10 dark:ring-white/[0.06] dark:shadow-black/40 dark:hover:border-white/20 dark:hover:shadow-black/50'
            }`}
          >
            {/* Subtle lavender background ambient */}
            <div
              aria-hidden="true"
              className="opacity-60 group-hover/dropzone:opacity-90 pointer-events-none absolute inset-0 rounded-3xl bg-[radial-gradient(ellipse_60%_60%_at_50%_45%,rgba(92,107,192,0.10),transparent_70%)] transition-opacity duration-300"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 hidden h-px bg-gradient-to-r from-transparent via-white/20 to-transparent dark:block"
            />

            <div className="relative flex flex-col items-center gap-6">
              {/* Cloud Upload Icon */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Select file"
                className="inline-flex items-center justify-center rounded-md text-[#5C6BC0] transition-all duration-300 group-hover/dropzone:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5C6BC0]/50 cursor-pointer"
              >
                <svg className="size-12 fill-current" viewBox="0 0 576 512">
                  <path d="M144 480c-79.5 0-144-64.5-144-144 0-63.4 41-117.2 97.9-136.5-1.3-7.7-1.9-15.5-1.9-23.5 0-79.5 64.5-144 144-144 55.4 0 103.5 31.3 127.6 77.1 14.2-8.3 30.8-13.1 48.4-13.1 53 0 96 43 96 96 0 15.7-3.8 30.6-10.5 43.7 44 20.3 74.5 64.7 74.5 116.3 0 70.7-57.3 128-128 128l-304 0zM305 191c-9.4-9.4-24.6-9.4-33.9 0l-72 72c-9.4 9.4-9.4 24.6 0 33.9s24.6 9.4 33.9 0l31-31 0 102.1c0 13.3 10.7 24 24 24s24-10.7 24-24l0-102.1 31 31c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-72-72z" />
                </svg>
              </button>

              {/* Text */}
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight text-neutral-900 dark:text-white sm:text-2xl">
                  Select your file to convert
                </h2>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 sm:text-base">
                  or drop your file here.
                </p>
              </div>

              {/* Signature Split CTA Button */}
              <div className="inline-flex">
                <div className="relative inline-flex -space-x-px w-full shadow-sm rounded-md overflow-visible">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-md font-semibold inline-flex items-center transition-colors px-4 py-2.5 text-base gap-2 rounded-r-none focus-visible:z-[1] text-white bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] outline-none"
                  >
                    <FilePlus2 className="size-5 shrink-0" />
                    <span>Select File</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                    aria-label="Select file source"
                    className="rounded-md font-medium inline-flex items-center transition-colors text-base rounded-l-none border-l border-white/20 focus-visible:z-[1] text-white bg-[#5C6BC0] hover:bg-[#4d5cb5] active:bg-[#3f4ea3] p-2.5 outline-none"
                  >
                    <ChevronDown className={`size-5 transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {/* Upload Options Dropdown */}
                  {isDropdownOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setIsDropdownOpen(false)}
                      />
                      <div className="absolute top-full right-0 mt-2 w-56 bg-neutral-900 rounded-xl shadow-2xl border border-neutral-700/80 p-1.5 z-50 animate-in fade-in duration-150 text-left">
                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                        >
                          <HardDrive className="w-4 h-4 text-[#5C6BC0]" />
                          <span>From my computer</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            setIsUrlModalOpen(true);
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                        >
                          <Globe className="w-4 h-4 text-[#5C6BC0]" />
                          <span>By URL</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                        >
                          <FolderOpen className="w-4 h-4 text-[#5C6BC0]" />
                          <span>From Google Drive</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/5 rounded-lg transition-colors"
                        >
                          <Archive className="w-4 h-4 text-[#5C6BC0]" />
                          <span>From Dropbox</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
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
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Source Format Selector Modal */}
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

      {/* Target Format Selector Modal */}
      {isTargetSelectorOpen && (
        <FormatSelector
          availableFormats={getAvailableTargetFormats(sourceFormat)}
          selectedFormatId={targetFormat}
          onSelect={(fmt) => setTargetFormat(fmt)}
          onClose={() => setIsTargetSelectorOpen(false)}
          title={`Convert ${sourceFormat.toUpperCase()} to:`}
        />
      )}

      {/* URL Ingestion Modal */}
      {isUrlModalOpen && (
        <UrlImportModal
          isOpen={isUrlModalOpen}
          onAddFile={(file) => onFilesSelected([file], targetFormat === 'any' ? 'docx' : targetFormat)}
          onClose={() => setIsUrlModalOpen(false)}
        />
      )}
    </>
  );
}
