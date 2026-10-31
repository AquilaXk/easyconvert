'use client';

import React, { useState, useRef, useEffect } from 'react';
import { getAvailableTargetFormats } from '@/lib/registry';
import UrlImportModal from './UrlImportModal';
import HeroFormatTiles from './workbench/HeroFormatTiles';
import HeroDropzoneCard from './workbench/HeroDropzoneCard';
import {
  computeHeroSubtitle,
  computeHeroTitle,
  QueueSummaryInput,
  resolveQueueSummary,
} from './workbench/hero-copy';

export interface HeroProps {
  onFilesSelected: (files: File[], defaultTarget?: string) => void;
  hasActiveQueue: boolean;
  activeSourceFormat?: string;
  activeTargetFormat?: string;
  initialSourceFormat?: string;
  initialTargetFormat?: string;
  categoryTitle?: string;
  categoryDescription?: string;
  activeQueueSummary?: QueueSummaryInput;
}

function getEffectiveTargetFormat(chosen?: string, fallback?: string): string | undefined {
  if (chosen && chosen.toLowerCase() !== 'any') return chosen.toLowerCase();
  if (fallback && fallback.toLowerCase() !== 'any') return fallback.toLowerCase();
  return undefined;
}

export default function Hero({
  onFilesSelected,
  hasActiveQueue,
  activeSourceFormat,
  activeTargetFormat,
  initialSourceFormat,
  initialTargetFormat,
  categoryTitle,
  categoryDescription,
  activeQueueSummary,
}: Readonly<HeroProps>) {
  const seedSource = activeSourceFormat ?? initialSourceFormat;
  const seedTarget = activeTargetFormat ?? initialTargetFormat;
  const [sourceFormat, setSourceFormat] = useState(seedSource ? seedSource.toLowerCase() : 'any');
  const [targetFormat, setTargetFormat] = useState(seedTarget ? seedTarget.toLowerCase() : 'any');
  const [userChangedTiles, setUserChangedTiles] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetFormatRef = useRef(targetFormat);
  const prevHasActiveQueueRef = useRef(hasActiveQueue);

  useEffect(() => {
    targetFormatRef.current = targetFormat;
  }, [targetFormat]);

  useEffect(() => {
    if (seedSource) setSourceFormat(seedSource.toLowerCase());
  }, [seedSource]);

  useEffect(() => {
    if (seedTarget) {
      const normalized = seedTarget.toLowerCase();
      setTargetFormat(normalized);
      targetFormatRef.current = normalized;
    }
  }, [seedTarget]);

  useEffect(() => {
    const wasActive = prevHasActiveQueueRef.current;
    prevHasActiveQueueRef.current = hasActiveQueue;
    if (wasActive && !hasActiveQueue && !seedSource && !seedTarget) {
      setSourceFormat('any');
      setTargetFormat('any');
      targetFormatRef.current = 'any';
      setUserChangedTiles(false);
    }
  }, [hasActiveQueue, seedSource, seedTarget]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const pastedFiles = e.clipboardData?.files;
      if (pastedFiles && pastedFiles.length > 0) {
        e.preventDefault();
        const files = Array.from(pastedFiles);
        const chosen = targetFormatRef.current;
        const effectiveTarget = getEffectiveTargetFormat(chosen, activeTargetFormat);
        onFilesSelected(files, effectiveTarget);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeTargetFormat, onFilesSelected]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      const chosen = targetFormatRef.current;
      const effectiveTarget = getEffectiveTargetFormat(chosen, activeTargetFormat);
      onFilesSelected(files, effectiveTarget);
      e.target.value = '';
    }
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

  const handleSourceChange = (nextSource: string) => {
    const normalized = nextSource.toLowerCase();
    setSourceFormat(normalized);
    setUserChangedTiles(true);
    if (normalized !== 'any' && targetFormat !== 'any') {
      const isCompatible = getAvailableTargetFormats(normalized).some(
        (fmt) => fmt.id.toLowerCase() === targetFormat.toLowerCase()
      );
      if (!isCompatible) {
        setTargetFormat('any');
        targetFormatRef.current = 'any';
      }
    }
  };

  const handleTargetChange = (nextTarget: string) => {
    const normalized = nextTarget.toLowerCase();
    setTargetFormat(normalized);
    targetFormatRef.current = normalized;
    setUserChangedTiles(true);
  };

  const title = computeHeroTitle({
    categoryTitle,
    hasActiveQueue,
    activeSourceFormat: seedSource,
    activeTargetFormat: seedTarget,
    sourceFormat,
    targetFormat,
    userChangedTiles,
  });
  const subtitle = computeHeroSubtitle(
    categoryDescription,
    hasActiveQueue,
    sourceFormat,
    targetFormat,
    userChangedTiles
  );
  const queueSummaryText = resolveQueueSummary(activeQueueSummary);

  return (
    <>
      <input
        id="main-file-input"
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="Select files to convert"
        onChange={handleFileChange}
      />

      {hasActiveQueue ? (
        <section className="bg-brand-950 dark:bg-[#111526] masthead-grid text-white py-6 sm:py-7 border-b border-white/10">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">{title}</h1>
              {queueSummaryText?.includes('files') && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-mono font-medium bg-white/10 text-slate-200 border border-white/15">
                  {queueSummaryText}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm text-slate-300 max-w-2xl">{subtitle}</p>
          </div>
        </section>
      ) : (
        <div>
          <section className="bg-brand-950 dark:bg-[#111526] masthead-grid text-white border-b border-white/10 pt-10 pb-24 lg:pt-14 lg:pb-28">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="lg:grid lg:grid-cols-12 lg:items-center lg:gap-10">
                <div className="lg:col-span-7 text-center lg:text-left">
                  <h1 className="text-3xl sm:text-4xl lg:text-[44px] font-bold tracking-tight text-white leading-[1.15]">
                    {title}
                  </h1>
                  <p className="mt-3 text-sm sm:text-base text-slate-300 max-w-2xl mx-auto lg:mx-0 leading-relaxed">
                    {subtitle}
                  </p>
                </div>
                <div className="lg:col-span-5 mt-7 lg:mt-0 flex justify-center lg:justify-end">
                  <HeroFormatTiles
                    sourceFormat={sourceFormat}
                    targetFormat={targetFormat}
                    onSourceChange={handleSourceChange}
                    onTargetChange={handleTargetChange}
                  />
                </div>
              </div>
            </div>
          </section>

          <HeroDropzoneCard
            isDragOver={isDragOver}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragOver(false);
            }}
            onDrop={handleDrop}
            onOpenFileDialog={() => fileInputRef.current?.click()}
            onOpenUrlModal={() => setIsUrlModalOpen(true)}
          />
        </div>
      )}

      {isUrlModalOpen && (
        <UrlImportModal
          isOpen={isUrlModalOpen}
          onAddFile={(file) => {
            const chosen = targetFormatRef.current;
            const effectiveTarget = getEffectiveTargetFormat(chosen, activeTargetFormat);
            onFilesSelected([file], effectiveTarget);
          }}
          onClose={() => setIsUrlModalOpen(false)}
        />
      )}
    </>
  );
}
