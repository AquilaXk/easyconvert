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
  Sparkles,
  CheckCircle2,
} from 'lucide-react';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
import FormatSelector from './FormatSelector';
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
  // Default to PDF to DOCX as standard format conversion pair
  const [sourceFormat, setSourceFormat] = useState(activeSourceFormat || 'pdf');
  const [targetFormat, setTargetFormat] = useState(activeTargetFormat || 'docx');
  const [isSourceSelectorOpen, setIsSourceSelectorOpen] = useState(false);
  const [isTargetSelectorOpen, setIsTargetSelectorOpen] = useState(false);
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

  const getFormatIcon = (fmt: string, isTarget = false) => {
    const def = FORMAT_REGISTRY[fmt?.toLowerCase()];
    const cat = def?.category;
    const colorClass = isTarget ? 'text-indigo-200' : 'text-neutral-200';
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

  const getFormatCategoryName = (fmt: string) => {
    const def = FORMAT_REGISTRY[fmt?.toLowerCase()];
    if (!def) return 'File Format';
    switch (def.category) {
      case 'document':
        return 'Document';
      case 'image':
        return 'Raster Image';
      case 'audio':
        return 'Audio Media';
      case 'video':
        return 'Video Media';
      case 'archive':
        return 'Archive Package';
      case 'ebook':
        return 'Digital E-Book';
      case 'spreadsheet':
        return 'Spreadsheet';
      case 'presentation':
        return 'Slide Deck';
      case 'cad':
        return 'CAD Drawing';
      case 'vector':
        return 'Vector Graphic';
      case 'font':
        return 'Vector Font';
      case 'data':
        return 'Structured Data';
      default:
        return def.name || 'Format';
    }
  };

  // Dynamic titles based on active source and target formats
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
      return 'Drop a file and pick what to turn it into. EasyConvert handles 292 formats across documents, images, audio, video, archives and more — straight from your browser.';
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

      {/* 1. EASYCONVERT OBSIDIAN BRAND HERO SECTION */}
      <section className={`group relative overflow-hidden bg-[#0B0E1B] text-white ${hasActiveQueue ? 'condensed pb-8 pt-16' : 'pb-36 pt-20 sm:pt-24'} border-b border-white/[0.06]`}>
        {/* Signature brand luminous gradient backdrop */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-15%,rgba(92,107,192,0.22),transparent_75%)] pointer-events-none"
        />

        {/* Ambient spotlight for the console dock */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle_500px_at_80%_35%,rgba(142,156,230,0.1),transparent)] pointer-events-none"
        />

        {/* Precision blueprint micro-lattice */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(rgba(255, 255, 255, 0.5) 1px, transparent 1px)`,
            backgroundSize: '24px 24px',
          }}
        />

        <div className="relative mx-auto max-w-7xl px-6 sm:px-8 lg:py-6">
          <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
            {/* Left Column: Heading, Subtitle & Value Proposition */}
            <div className="text-center lg:text-left">
              {/* Brand Kicker Badge */}
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-brand-500/15 border border-brand-400/30 text-brand-200 mb-4 shadow-sm">
                <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Client-Side Engine • 292 Formats • Zero Server Storage</span>
              </div>

              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight text-white leading-[1.12]">
                {getHeroTitle()}
              </h1>
              <p className="mt-4 text-base sm:text-lg sm:leading-relaxed text-neutral-300 max-w-xl">
                {getHeroSubtitle()}
              </p>

              {/* Value Proposition Micro-badges */}
              <div className="mt-6 flex flex-wrap items-center justify-center lg:justify-start gap-x-5 gap-y-2 text-xs font-medium text-neutral-300">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-brand-400 shrink-0" />
                  <span>Zero queue latency</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-brand-400 shrink-0" />
                  <span>Preserves layouts &amp; tables</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-brand-400 shrink-0" />
                  <span>100% In-browser sandbox</span>
                </span>
              </div>
            </div>

            {/* Right Column: EasyConvert Signature Conversion Console Deck */}
            <div className="relative flex justify-center lg:justify-end">
              <div className="relative w-full max-w-lg lg:max-w-xl">
                {/* Luminous aura behind console */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-1 rounded-3xl bg-gradient-to-r from-brand-700/20 via-brand-500/15 to-brand-700/20 blur-xl opacity-75"
                />

                {/* Console Housing */}
                <div className="relative rounded-3xl bg-[#14182B]/95 border border-[#2B3556] p-4 sm:p-5 shadow-[0_24px_50px_-12px_rgba(6,8,18,0.7),inset_0_1px_0_0_rgba(255,255,255,0.08)] backdrop-blur-xl">
                  {/* Console Header Bar */}
                  <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/[0.08] text-xs">
                    <div className="flex items-center gap-2">
                      <span className="size-2 rounded-full bg-brand-400 animate-pulse" />
                      <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-brand-300">
                        Conversion Console
                      </span>
                    </div>
                    <span className="text-[11px] text-neutral-400 font-mono">
                      292 Standards Supported
                    </span>
                  </div>

                  {/* The Two Cards & Central Swap Bridge */}
                  <div className="relative z-10 flex items-center justify-between gap-2 sm:gap-3 py-1">
                    {/* Left Card: Source Format */}
                    <div className="relative flex-1">
                      <button
                        type="button"
                        onClick={() => {
                          setIsSourceSelectorOpen(!isSourceSelectorOpen);
                          setIsTargetSelectorOpen(false);
                        }}
                        className="group/card relative w-full flex flex-col justify-between p-3 sm:p-4 h-[7.75rem] sm:h-[8.5rem] rounded-2xl bg-white/[0.04] hover:bg-white/[0.07] border border-white/10 hover:border-brand-400/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_20px_rgba(0,0,0,0.3)] transition-all duration-200 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-700 active:scale-[0.98] cursor-pointer"
                        aria-label={`Input format: ${sourceFormat.toUpperCase()}. Click to change.`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-[10px] font-mono font-bold tracking-widest uppercase text-neutral-400 group-hover/card:text-brand-300">
                            FROM
                          </span>
                          <span className="p-1 rounded-md bg-white/[0.05] group-hover/card:bg-white/[0.1] text-neutral-400 group-hover/card:text-white transition-colors">
                            <ChevronDown className="size-3" />
                          </span>
                        </div>

                        <div key={sourceFormat} className="animate-card-flip flex items-center gap-2.5 sm:gap-3">
                          <div className="p-2 rounded-xl bg-white/[0.06] border border-white/10 group-hover/card:border-brand-400/40 text-brand-300 shrink-0 transition-transform duration-200 group-hover/card:scale-105">
                            {getFormatIcon(sourceFormat, false)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-base sm:text-lg font-black tracking-tight text-white uppercase truncate">
                              {sourceFormat}
                            </div>
                            <div className="text-[10px] sm:text-[11px] font-medium text-neutral-400 truncate">
                              {getFormatCategoryName(sourceFormat)}
                            </div>
                          </div>
                        </div>
                      </button>

                      {isSourceSelectorOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setIsSourceSelectorOpen(false)} />
                          <div className="absolute left-1/2 -translate-x-1/2 sm:translate-x-0 sm:left-0 top-full mt-2 z-50">
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

                    {/* Center Flow Bridge & Swap */}
                    <div className="flex flex-col items-center justify-center shrink-0 px-0.5 sm:px-1 gap-1.5">
                      <div className="flex items-center">
                        <div className="h-0.5 w-1.5 sm:w-2.5 bg-gradient-to-r from-transparent to-brand-500/50" />
                        <button
                          type="button"
                          onClick={() => {
                            if (targetFormat.toLowerCase() === 'any') return;
                            const tmp = sourceFormat;
                            setSourceFormat(targetFormat);
                            setTargetFormat(tmp);
                            targetFormatRef.current = tmp;
                          }}
                          disabled={targetFormat.toLowerCase() === 'any'}
                          title={targetFormat.toLowerCase() === 'any' ? 'Select specific output format to swap' : 'Swap formats'}
                          className={`group/swap relative flex size-9 sm:size-10 items-center justify-center rounded-full border transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 ${
                            targetFormat.toLowerCase() === 'any'
                              ? 'opacity-40 cursor-not-allowed border-neutral-700 bg-neutral-800/40 text-neutral-500'
                              : 'cursor-pointer border-brand-400/40 bg-gradient-to-b from-[#6878D0] to-[#4A58A9] hover:from-[#7484DC] hover:to-[#5564B5] active:scale-95 text-white shadow-lg shadow-brand-700/30 hover:shadow-brand-700/50 hover:scale-105'
                          }`}
                          aria-label="Swap formats"
                        >
                          <RefreshCw className={`size-4 transition-transform duration-300 text-white ${targetFormat.toLowerCase() !== 'any' ? 'group-hover/swap:rotate-180' : ''}`} />
                        </button>
                        <div className="h-0.5 w-1.5 sm:w-2.5 bg-gradient-to-r from-brand-500/50 to-transparent" />
                      </div>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase tracking-wider text-brand-300 bg-brand-900/70 border border-brand-500/30">
                        TO
                      </span>
                    </div>

                    {/* Right Card: Target Format */}
                    <div className="relative flex-1">
                      <button
                        type="button"
                        onClick={() => {
                          setIsTargetSelectorOpen(!isTargetSelectorOpen);
                          setIsSourceSelectorOpen(false);
                        }}
                        className="group/card relative w-full flex flex-col justify-between p-3 sm:p-4 h-[7.75rem] sm:h-[8.5rem] rounded-2xl bg-gradient-to-br from-brand-600/15 to-brand-900/25 hover:from-brand-600/20 hover:to-brand-900/35 border border-brand-500/50 hover:border-brand-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_24px_rgba(92,107,192,0.22)] transition-all duration-200 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-700 active:scale-[0.98] cursor-pointer"
                        aria-label={`Output format: ${targetFormat.toUpperCase()}. Click to change.`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-[10px] font-mono font-bold tracking-widest uppercase text-brand-300">
                            INTO
                          </span>
                          <span className="p-1 rounded-md bg-brand-500/20 group-hover/card:bg-brand-500/30 text-brand-200 group-hover/card:text-white transition-colors">
                            <ChevronDown className="size-3" />
                          </span>
                        </div>

                        <div key={targetFormat} className="animate-card-flip flex items-center gap-2.5 sm:gap-3">
                          <div className="p-2 rounded-xl bg-brand-500/20 border border-brand-400/40 text-brand-200 shrink-0 transition-transform duration-200 group-hover/card:scale-105">
                            {getFormatIcon(targetFormat, true)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-base sm:text-lg font-black tracking-tight text-brand-100 uppercase truncate">
                              {targetFormat}
                            </div>
                            <div className="text-[10px] sm:text-[11px] font-medium text-brand-300/80 truncate">
                              {getFormatCategoryName(targetFormat)}
                            </div>
                          </div>
                        </div>
                      </button>

                      {isTargetSelectorOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setIsTargetSelectorOpen(false)} />
                          <div className="absolute left-1/2 -translate-x-1/2 sm:translate-x-0 sm:left-auto sm:right-0 top-full mt-2 z-50">
                            <FormatSelector
                              availableFormats={getAvailableTargetFormats(sourceFormat)}
                              selectedFormatId={targetFormat}
                              onSelect={(fmt) => {
                                setTargetFormat(fmt);
                                targetFormatRef.current = fmt;
                              }}
                              onClose={() => setIsTargetSelectorOpen(false)}
                              title={`Convert ${sourceFormat.toUpperCase()} to:`}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Popular Presets Workflows */}
                  <div className="mt-4 pt-3.5 border-t border-white/[0.08]">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase text-neutral-400 mb-2">
                      <Sparkles className="size-3 text-brand-400 shrink-0" />
                      <span>POPULAR:</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2">
                      {[
                        { label: 'PDF to Word', src: 'pdf', tgt: 'docx' },
                        { label: 'Word to PDF', src: 'docx', tgt: 'pdf' },
                        { label: 'Image to WebP', src: 'png', tgt: 'webp' },
                        { label: 'Video to MP3', src: 'mp4', tgt: 'mp3' },
                        { label: 'HEIC to JPG', src: 'heic', tgt: 'jpg' },
                        { label: 'EPUB to PDF', src: 'epub', tgt: 'pdf' },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            setSourceFormat(preset.src);
                            setTargetFormat(preset.tgt);
                            targetFormatRef.current = preset.tgt;
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center justify-between px-2.5 py-1.5 text-xs font-semibold rounded-xl bg-white/[0.04] hover:bg-brand-700/25 text-neutral-300 hover:text-white border border-white/[0.08] hover:border-brand-500/50 transition-all cursor-pointer shadow-sm group/btn text-left"
                        >
                          <span className="truncate">{preset.label}</span>
                          <span className="text-[10px] text-neutral-500 group-hover/btn:text-brand-300 ml-1">→</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. FLOATING DROPZONE CARD */}
      {!hasActiveQueue && (
        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col px-4 pb-6 sm:px-6 -mt-24">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`group/dropzone relative mx-auto mb-10 w-full max-w-3xl overflow-visible rounded-3xl border bg-white px-6 py-9 text-center shadow-xl ring-1 transition-all duration-300 ease-out sm:px-10 sm:py-11 dark:bg-[#151A2E] ${
              isDragOver
                ? 'border-brand-700 border-2 border-dashed ring-4 ring-brand-700/20 scale-[1.01] bg-brand-50/50 dark:bg-brand-950/20'
                : 'border-neutral-200/90 ring-black/[0.03] shadow-brand-950/5 hover:border-brand-300 hover:shadow-brand-950/10 dark:border-[#283252] dark:ring-white/[0.04] dark:shadow-black/50 dark:hover:border-brand-500/40'
            }`}
          >
            {/* Subtle lavender background ambient */}
            <div
              aria-hidden="true"
              className="opacity-50 group-hover/dropzone:opacity-90 pointer-events-none absolute inset-0 rounded-3xl bg-[radial-gradient(ellipse_60%_60%_at_50%_45%,rgba(92,107,192,0.1),transparent_70%)] transition-opacity duration-300"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 hidden h-px bg-gradient-to-r from-transparent via-white/20 to-transparent dark:block"
            />

            <div className="relative flex flex-col items-center gap-6">
              {/* Official Brand Vector Mark on Soft Squircle Plate */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Select files to convert"
                className="group/icon relative inline-flex items-center justify-center p-4 rounded-2xl bg-brand-50/80 dark:bg-[#1E2540] border border-brand-200/80 dark:border-brand-600/30 shadow-md shadow-brand-700/10 hover:shadow-lg hover:shadow-brand-700/20 transition-all duration-300 group-hover/dropzone:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 cursor-pointer"
              >
                <BrandIcon size={44} />
              </button>

              {/* Text */}
              <div className="space-y-1">
                <h2 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-white sm:text-2xl">
                  Choose Files to Convert
                </h2>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 sm:text-base">
                  Drop files here, or paste from clipboard
                </p>
              </div>

              {/* Signature Split CTA Button */}
              <div className="inline-flex">
                <div className="relative inline-flex -space-x-px w-full shadow-md rounded-xl overflow-visible">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-l-xl font-semibold inline-flex items-center transition-all px-5 py-3 text-base gap-2.5 focus-visible:z-[1] text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 outline-none shadow-md shadow-brand-700/20 cursor-pointer"
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
                    className="rounded-r-xl font-semibold inline-flex items-center transition-all text-base border-l border-white/20 focus-visible:z-[1] text-white bg-brand-700 hover:bg-brand-800 active:bg-brand-900 px-3.5 py-3 outline-none cursor-pointer"
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
                      <div className="absolute top-full right-0 mt-2 w-56 bg-[#161B2E] rounded-2xl shadow-2xl border border-[#283252] p-1.5 z-50 animate-in fade-in duration-150 text-left">
                        <button
                          type="button"
                          onClick={() => {
                            setIsDropdownOpen(false);
                            fileInputRef.current?.click();
                          }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-brand-700/20 rounded-xl transition-colors"
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
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-brand-700/20 rounded-xl transition-colors"
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
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-brand-700/20 rounded-xl transition-colors"
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
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-brand-700/20 rounded-xl transition-colors"
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
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-brand-700/20 rounded-xl transition-colors"
                        >
                          <FolderOpen className="w-4 h-4 text-neutral-400" />
                          <span>From OneDrive</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Trust & Spec Badges */}
              <div className="flex items-center justify-center flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400 pt-1">
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
