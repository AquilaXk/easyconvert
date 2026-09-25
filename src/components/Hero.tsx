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
  // Default to PDF to DOCX matching live CloudConvert hero defaults
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
      onFilesSelected(files, activeTargetFormat);
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
      onFilesSelected(files, activeTargetFormat);
    }
  };

  const getFormatIcon = (fmt: string, isTarget = false) => {
    const def = FORMAT_REGISTRY[fmt?.toLowerCase()];
    const cat = def?.category;
    const colorClass = isTarget ? 'text-red-200' : 'text-neutral-200';
    if (fmt?.toLowerCase() === 'pdf') {
      return (
        <svg className={`size-7 sm:size-8 ${colorClass}`} viewBox="0 0 576 512" fill="currentColor">
          <path d="M96 0C60.7 0 32 28.7 32 64l0 384c0 35.3 28.7 64 64 64l80 0 0-112c0-35.3 28.7-64 64-64l176 0 0-165.5c0-17-6.7-33.3-18.7-45.3L290.7 18.7C278.7 6.7 262.5 0 245.5 0L96 0zM357.5 176L264 176c-13.3 0-24-10.7-24-24L240 58.5 357.5 176zM240 380c-11 0-20 9-20 20l0 128c0 11 9 20 20 20s20-9 20-20l0-28 12 0c33.1 0 60-26.9 60-60s-26.9-60-60-60l-32 0zm32 80l-12 0 0-40 12 0c11 0 20 9 20 20s-9 20-20 20zm96-80c-11 0-20 9-20 20l0 128c0 11 9 20 20 20l32 0c28.7 0 52-23.3 52-52l0-64c0-28.7-23.3-52-52-52l-32 0zm20 128l0-88 12 0c6.6 0 12 5.4 12 12l0 64c0 6.6-5.4 12-12 12l-12 0zm88-108l0 128c0 11 9 20 20 20s20-9 20-20l0-44 28 0c11 0 20-9 20-20s-9-20-20-20l-28 0 0-24 28 0c11 0 20-9 20-20s-9-20-20-20l-48 0c-11 0-20 9-20 20z" />
        </svg>
      );
    }
    if (fmt?.toLowerCase() === 'svg') {
      return (
        <svg className={`size-7 sm:size-8 ${colorClass}`} viewBox="0 0 512 512" fill="currentColor">
          <path d="M32 119.4C12.9 108.4 0 87.7 0 64 0 28.7 28.7 0 64 0 87.7 0 108.4 12.9 119.4 32l273.1 0c11.1-19.1 31.7-32 55.4-32 35.3 0 64 28.7 64 64 0 23.7-12.9 44.4-32 55.4l0 273.1c19.1 11.1 32 31.7 32 55.4 0 35.3-28.7 64-64 64-23.7 0-44.4-12.9-55.4-32l-273.1 0c-11.1 19.1-31.7 32-55.4 32-35.3 0-64-28.7-64-64 0-23.7 12.9-44.4 32-55.4l0-273.1zm64 0l0 273.1c9.7 5.6 17.8 13.7 23.4 23.4l273.1 0c5.6-9.7 13.7-17.8 23.4-23.4l0-273.1c-9.7-5.6-17.8-13.7-23.4-23.4L119.4 96c-5.6 9.7-13.7 17.8-23.4 23.4z" />
        </svg>
      );
    }
    switch (cat) {
      case 'audio':
        return (
          <svg className={`size-7 sm:size-8 ${colorClass}`} viewBox="0 0 384 512" fill="currentColor">
            <path d="M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zm53.8 185.2c-9.1-6.3-21.5-4.1-27.8 5s-4.1 21.5 5 27.8c23.9 16.7 39.4 44.3 39.4 75.5s-15.6 58.9-39.4 75.5c-9.1 6.3-11.3 18.8-5 27.8s18.8 11.3 27.8 5c34.1-23.8 56.6-63.5 56.6-108.3S296 267.5 261.8 243.7zM80 312c-8.8 0-16 7.2-16 16l0 48c0 8.8 7.2 16 16 16l24 0 27.2 34c3 3.8 7.6 6 12.5 6l.3 0c8.8 0 16-7.2 16-16l0-128c0-8.8-7.2-16-16-16l-.3 0c-4.9 0-9.5 2.2-12.5 6l-27.2 34-24 0zm128 72.2c0 10.7 10.5 18.2 18.9 11.6 12.9-10.3 21.1-26.1 21.1-43.8s-8.2-33.5-21.1-43.8c-8.4-6.7-18.9 .9-18.9 11.6l0 64.5z" />
          </svg>
        );
      case 'video':
        return (
          <svg className={`size-7 sm:size-8 ${colorClass}`} viewBox="0 0 384 512" fill="currentColor">
            <path d="M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM80 304l0 96c0 17.7 14.3 32 32 32l96 0c17.7 0 32-14.3 32-32l0-24 35 35c3.2 3.2 7.5 5 12 5 9.4 0 17-7.6 17-17l0-94.1c0-9.4-7.6-17-17-17-4.5 0-8.8 1.8-12 5l-35 35 0-24c0-17.7-14.3-32-32-32l-96 0c-17.7 0-32 14.3-32 32z" />
          </svg>
        );
      case 'image':
        return (
          <svg className={`size-7 sm:size-8 ${colorClass}`} viewBox="0 0 384 512" fill="currentColor">
            <path d="M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM128 256a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM92.6 448l198.8 0c15.8 0 28.6-12.8 28.6-28.6 0-7.3-2.8-14.4-7.9-19.7L215.3 297.9c-6-6.3-14.4-9.9-23.2-9.9l-.3 0c-8.8 0-17.1 3.6-23.2 9.9L71.9 399.7C66.8 405 64 412.1 64 419.4 64 435.2 76.8 448 92.6 448z" />
          </svg>
        );
      default:
        return (
          <svg className={`size-7 sm:size-8 ${colorClass}`} viewBox="0 0 384 512" fill="currentColor">
            <path d="M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM120 256c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0zm0 96c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-144 0z" />
          </svg>
        );
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
      <section className={`group relative overflow-hidden bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 text-white ${hasActiveQueue ? 'condensed pb-8 pt-20' : 'pb-44 pt-24'}`}>
        {/* Exact red radial gradient */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_70%_-10%,rgba(120,40,40,0.3),transparent)] pointer-events-none"
        />

        {/* Subtle grid pattern background */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.05] pointer-events-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3Cpattern id='g' width='60' height='60' patternUnits='userSpaceOnUse'%3E%3Cpath d='M 60 0 L 0 0 0 60' fill='none' stroke='white' stroke-width='0.5'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23g)'/%3E%3C/svg%3E")`,
          }}
        />

        <div className="relative mx-auto max-w-7xl px-8 lg:py-8">
          <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
            {/* Left Column: Heading and Subtitle */}
            <div className="text-center lg:text-left">
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-white">
                {getHeroTitle()}
              </h1>
              <p className="mt-5 text-base sm:text-lg sm:leading-relaxed text-neutral-300 max-w-xl">
                {getHeroSubtitle()}
              </p>
            </div>

            {/* Right Column: Signature 2-Card Interactive Widget with Orbit Rings */}
            <div className="relative flex justify-center lg:justify-end lg:pt-10">
              <div className="relative flex w-full max-w-md items-center justify-center">
                {/* Orbit rings */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute size-[280px] sm:size-[320px] rounded-full border border-white/[0.05] animate-orbit-slow"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute size-[200px] sm:size-[230px] rounded-full border border-white/[0.07] animate-orbit-fast"
                />
                {/* Red glow behind target */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute size-40 rounded-full bg-[#d9383a]/15 blur-3xl"
                />

                {/* The Two Cards Widget */}
                <div className="relative z-10 flex items-center gap-3 sm:gap-4">
                  {/* Left Card: Source Format */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setIsSourceSelectorOpen(!isSourceSelectorOpen);
                        setIsTargetSelectorOpen(false);
                      }}
                      className="group/card relative flex h-[6.75rem] w-24 sm:h-[7.5rem] sm:w-28 cursor-pointer items-center justify-center rounded-[0.85rem] border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-md transition duration-300 ease-out hover:-translate-y-0.5 hover:border-white/20 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_12px_30px_rgba(0,0,0,0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d9383a]/60 active:translate-y-0"
                      aria-label={`Input format: ${sourceFormat.toUpperCase()}. Click to change.`}
                    >
                      <div
                        key={sourceFormat}
                        className="animate-card-flip relative flex h-full w-full flex-col items-center justify-center gap-2 px-2"
                      >
                        <div className="transition-transform duration-300 group-hover/card:scale-110">
                          {getFormatIcon(sourceFormat, false)}
                        </div>
                        <span className="max-w-full truncate text-xs sm:text-sm font-bold tracking-wider text-neutral-100 uppercase">
                          {sourceFormat}
                        </span>
                      </div>
                      <ChevronDown className="absolute right-2 bottom-1.5 size-2.5 text-neutral-500 transition-colors group-hover/card:text-neutral-300" />
                    </button>

                    {isSourceSelectorOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setIsSourceSelectorOpen(false)} />
                        <div className="absolute left-0 top-full mt-2 z-50">
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
                        </div>
                      </>
                    )}
                  </div>

                  {/* Center Circle: TO Indicator */}
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex items-center">
                      <div className="relative h-px w-5 sm:w-7 overflow-hidden bg-gradient-to-r from-neutral-700 to-[#d9383a]/70" aria-hidden="true">
                        <div className="absolute inset-0 h-px animate-arrow-sweep bg-gradient-to-r from-transparent via-[#f87171] to-transparent" />
                      </div>

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
                        className={`group/op relative mx-1 flex size-9 sm:size-10 items-center justify-center rounded-full border backdrop-blur-sm transition duration-300 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d9383a]/60 ${
                          targetFormat.toLowerCase() === 'any'
                            ? 'opacity-40 cursor-not-allowed border-neutral-700 bg-neutral-800/40 text-neutral-500'
                            : 'cursor-pointer border-[#d9383a]/40 bg-[#d9383a]/15 hover:scale-110 hover:border-[#d9383a]/70 hover:bg-[#d9383a]/25 text-[#d9383a]'
                        }`}
                        aria-label="Swap formats"
                      >
                        <RefreshCw className={`size-4 transition-transform duration-300 text-red-300 animate-spin-pulse ${targetFormat.toLowerCase() !== 'any' ? 'group-hover/op:animate-none group-hover/op:rotate-180' : ''}`} />
                        {targetFormat.toLowerCase() !== 'any' && (
                          <div className="pointer-events-none absolute inset-0 animate-ping rounded-full ring-1 ring-[#d9383a]/20" aria-hidden="true" />
                        )}
                      </button>

                      <div className="relative h-px w-5 sm:w-7 overflow-hidden bg-gradient-to-r from-[#d9383a]/70 to-neutral-700" aria-hidden="true">
                        <div className="absolute inset-0 h-px animate-arrow-sweep bg-gradient-to-r from-transparent via-[#f87171] to-transparent" />
                      </div>
                    </div>
                    <span className="text-[0.65rem] font-medium uppercase tracking-[0.25em] text-neutral-400">
                      to
                    </span>
                  </div>

                  {/* Right Card: Target Format (Highlighted with Red Glow) */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setIsTargetSelectorOpen(!isTargetSelectorOpen);
                        setIsSourceSelectorOpen(false);
                      }}
                      className="group/card relative flex h-[6.75rem] w-24 sm:h-[7.5rem] sm:w-28 cursor-pointer items-center justify-center rounded-[0.85rem] border border-[#d9383a]/35 bg-gradient-to-br from-white/[0.07] to-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_32px_rgba(217,56,58,0.22)] backdrop-blur-md transition duration-300 ease-out animate-output-pulse hover:-translate-y-0.5 hover:border-[#d9383a]/55 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_38px_rgba(217,56,58,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d9383a]/60 active:translate-y-0"
                      aria-label={`Output format: ${targetFormat.toUpperCase()}. Click to change.`}
                    >
                      <div
                        key={targetFormat}
                        className="animate-card-flip relative flex h-full w-full flex-col items-center justify-center gap-2 px-2"
                      >
                        <div className="transition-transform duration-300 group-hover/card:scale-110">
                          {getFormatIcon(targetFormat, true)}
                        </div>
                        <span className="max-w-full truncate text-xs sm:text-sm font-bold tracking-wider text-red-100 uppercase">
                          {targetFormat}
                        </span>
                      </div>
                      <ChevronDown className="absolute right-2 bottom-1.5 size-2.5 text-red-300/60 transition-colors group-hover/card:text-red-200" />
                    </button>

                    {isTargetSelectorOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setIsTargetSelectorOpen(false)} />
                        <div className="absolute right-0 top-full mt-2 z-50">
                          <FormatSelector
                            availableFormats={getAvailableTargetFormats(sourceFormat)}
                            selectedFormatId={targetFormat}
                            onSelect={(fmt) => setTargetFormat(fmt)}
                            onClose={() => setIsTargetSelectorOpen(false)}
                            title={`Convert ${sourceFormat.toUpperCase()} to:`}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. FLOATING DROPZONE CARD */}
      {!hasActiveQueue && (
        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col px-4 pb-6 sm:px-6 -mt-32">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`group/dropzone relative mx-auto mb-10 w-full max-w-2xl overflow-visible rounded-3xl border bg-white px-6 py-8 text-center shadow-xl ring-1 transition-all duration-300 ease-out sm:px-10 sm:py-10 dark:bg-neutral-900 ${
              isDragOver
                ? 'border-[#d9383a] ring-[#d9383a]/30 scale-[1.01]'
                : 'border-neutral-200/80 ring-black/[0.04] shadow-neutral-950/10 hover:border-neutral-300 hover:shadow-neutral-950/15 dark:border-white/10 dark:ring-white/[0.06] dark:shadow-black/40 dark:hover:border-white/20 dark:hover:shadow-black/50'
            }`}
          >
            {/* Subtle red background ambient */}
            <div
              aria-hidden="true"
              className="opacity-60 group-hover/dropzone:opacity-90 pointer-events-none absolute inset-0 rounded-3xl bg-[radial-gradient(ellipse_60%_60%_at_50%_45%,rgba(217,56,58,0.08),transparent_70%)] transition-opacity duration-300"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 hidden h-px bg-gradient-to-r from-transparent via-white/20 to-transparent dark:block"
            />

            <div className="relative flex flex-col items-center gap-6">
              {/* Cloud Upload Icon matching CloudConvert */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Select file"
                className="inline-flex items-center justify-center rounded-md text-[#d9383a] transition-all duration-300 group-hover/dropzone:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d9383a]/50 cursor-pointer"
              >
                <svg className="size-11 fill-current" viewBox="0 0 576 512">
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
                    className="rounded-md font-medium inline-flex items-center transition-colors px-3 py-2 text-base gap-2 rounded-r-none focus-visible:z-[1] text-white bg-[#d9383a] hover:bg-[#c22e30] active:bg-[#a82325] outline-none"
                  >
                    <svg className="size-5 fill-current shrink-0" viewBox="0 0 384 512">
                      <path d="M0 64C0 28.7 28.7 0 64 0L213.5 0c17 0 33.3 6.7 45.3 18.7L365.3 125.3c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64zm208-5.5l0 93.5c0 13.3 10.7 24 24 24L325.5 176 208 58.5zM192 240c-13.3 0-24 10.7-24 24l0 48-48 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l48 0 0 48c0 13.3 10.7 24 24 24s24-10.7 24-24l0-48 48 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-48 0 0-48c0-13.3-10.7-24-24-24z" />
                    </svg>
                    <span>Select File</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                    aria-label="Select file source"
                    className="rounded-md font-medium inline-flex items-center transition-colors text-base rounded-l-none border-l border-white/20 focus-visible:z-[1] text-white bg-[#d9383a] hover:bg-[#c22e30] active:bg-[#a82325] p-2 outline-none"
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
                      <div className="absolute top-full right-0 mt-2 w-56 bg-[#212529] rounded-xl shadow-2xl border border-neutral-700/80 p-1.5 z-50 animate-in fade-in duration-150 text-left">
                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                        >
                          <HardDrive className="w-4 h-4 text-neutral-400" />
                          <span>From my computer</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            setIsUrlModalOpen(true);
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                        >
                          <Globe className="w-4 h-4 text-neutral-400" />
                          <span>By URL</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                        >
                          <FolderOpen className="w-4 h-4 text-neutral-400" />
                          <span>From Google Drive</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-neutral-800/60 rounded-lg transition-colors"
                        >
                          <Archive className="w-4 h-4 text-neutral-400" />
                          <span>From Dropbox</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
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
              </div>
            </div>
          </div>
        </div>
      )}

      {/* URL Ingestion Modal */}
      {isUrlModalOpen && (
        <UrlImportModal
          isOpen={isUrlModalOpen}
          onAddFile={(file) => onFilesSelected([file], targetFormat === 'any' ? 'mp3' : targetFormat)}
          onClose={() => setIsUrlModalOpen(false)}
        />
      )}
    </>
  );
}
