'use client';

import React, { useState, useRef, useEffect } from 'react';
import { getAvailableTargetFormats } from '@/lib/registry';
import { REGISTRY_STATS } from '@/lib/registry-stats';
import UrlImportModal from './UrlImportModal';
import HeroFormatTiles from './workbench/HeroFormatTiles';
import HeroDropzoneCard from './workbench/HeroDropzoneCard';

export interface HeroProps {
  onFilesSelected: (files: File[], defaultTarget?: string) => void;
  hasActiveQueue: boolean;
  activeSourceFormat?: string;
  activeTargetFormat?: string;
  categoryTitle?: string;
  categoryDescription?: string;
  activeQueueSummary?: { sourceFormats: string[]; targetFormats: string[] };
}

function getEffectiveTargetFormat(chosen?: string, fallback?: string): string | undefined {
  if (chosen && chosen.toLowerCase() !== 'any') {
    return chosen.toLowerCase();
  }
  if (fallback && fallback.toLowerCase() !== 'any') {
    return fallback.toLowerCase();
  }
  return undefined;
}

function computeHeroTitle({
  categoryTitle,
  hasActiveQueue,
  activeSourceFormat,
  activeTargetFormat,
  sourceFormat,
  targetFormat,
  userChangedTiles,
}: {
  categoryTitle?: string;
  hasActiveQueue: boolean;
  activeSourceFormat?: string;
  activeTargetFormat?: string;
  sourceFormat: string;
  targetFormat: string;
  userChangedTiles: boolean;
}): string {
  if (categoryTitle && !userChangedTiles) {
    return categoryTitle;
  }

  const src = (hasActiveQueue ? activeSourceFormat || sourceFormat : sourceFormat).toLowerCase();
  const tgt = (hasActiveQueue ? activeTargetFormat || targetFormat : targetFormat).toLowerCase();
  const hasSrc = Boolean(src && src !== 'any');
  const hasTgt = Boolean(tgt && tgt !== 'any');

  if (hasSrc && hasTgt) {
    return `${src.toUpperCase()} to ${tgt.toUpperCase()} Converter`;
  }
  if (hasSrc) {
    return `${src.toUpperCase()} Converter`;
  }
  if (hasTgt) {
    return `Convert to ${tgt.toUpperCase()}`;
  }
  return 'File Converter';
}

function computeHeroSubtitle({
  categoryDescription,
  hasActiveQueue,
  sourceFormat,
  targetFormat,
  userChangedTiles,
}: {
  categoryDescription?: string;
  hasActiveQueue: boolean;
  sourceFormat: string;
  targetFormat: string;
  userChangedTiles: boolean;
}): string {
  if (categoryDescription && !userChangedTiles && !hasActiveQueue) {
    return categoryDescription;
  }

  const countPhrase = `${REGISTRY_STATS.formatCount} formats in ${REGISTRY_STATS.categoryCount} categories`;

  if (hasActiveQueue) {
    return `Choose output formats, adjust parameters, and download converted files across ${countPhrase}.`;
  }

  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  const hasSrc = Boolean(src && src !== 'any');
  const hasTgt = Boolean(tgt && tgt !== 'any');

  if (hasSrc && hasTgt) {
    return `Convert ${src.toUpperCase()} to ${tgt.toUpperCase()} online. Supports ${countPhrase} with encrypted transfer and ephemeral processing.`;
  }
  if (hasSrc) {
    return `Convert ${src.toUpperCase()} files online across ${countPhrase} with encrypted transfer and ephemeral processing.`;
  }
  return `Convert documents, images, audio, video, structured data, and archives online across ${countPhrase}.`;
}

export default function Hero({
  onFilesSelected,
  hasActiveQueue,
  activeSourceFormat,
  activeTargetFormat,
  categoryTitle,
  categoryDescription,
}: HeroProps) {
  const [sourceFormat, setSourceFormat] = useState(
    activeSourceFormat ? activeSourceFormat.toLowerCase() : 'any'
  );
  const [targetFormat, setTargetFormat] = useState(
    activeTargetFormat ? activeTargetFormat.toLowerCase() : 'any'
  );
  const [userChangedTiles, setUserChangedTiles] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetFormatRef = useRef(targetFormat);

  useEffect(() => {
    targetFormatRef.current = targetFormat;
  }, [targetFormat]);

  useEffect(() => {
    if (activeSourceFormat) {
      setSourceFormat(activeSourceFormat.toLowerCase());
    }
  }, [activeSourceFormat]);

  useEffect(() => {
    if (activeTargetFormat) {
      const normalized = activeTargetFormat.toLowerCase();
      setTargetFormat(normalized);
      targetFormatRef.current = normalized;
    }
  }, [activeTargetFormat]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
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
    activeSourceFormat,
    activeTargetFormat,
    sourceFormat,
    targetFormat,
    userChangedTiles,
  });

  const subtitle = computeHeroSubtitle({
    categoryDescription,
    hasActiveQueue,
    sourceFormat,
    targetFormat,
    userChangedTiles,
  });

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
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              {title}
            </h1>
            <p className="mt-1.5 text-sm text-slate-300 max-w-2xl">
              {subtitle}
            </p>
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
