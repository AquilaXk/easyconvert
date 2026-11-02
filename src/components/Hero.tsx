'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Files, Lock, UserRound } from 'lucide-react';
import { getAvailableTargetFormats } from '@/lib/registry';
import { REGISTRY_STATS } from '@/lib/registry-stats';
import HeroFormatTiles from './workbench/HeroFormatTiles';
import HeroDropzoneCard from './workbench/HeroDropzoneCard';
import SourceChipPicker from './workbench/SourceChipPicker';
import PopularConversions from './workbench/PopularConversions';
import {
  computeHeroSubtitle,
  computeHeroTitle,
  describeQueueSummary,
  type QueueSummary,
} from './workbench/hero-copy';

/** The copy of a converter page, whose hero shows its pair as two tiles; the home page has none. */
export interface ConverterPair {
  title: string;
  description: string;
}

export interface HeroProps {
  onFilesSelected: (files: File[], defaultTarget?: string) => void;
  hasActiveQueue: boolean;
  /** The conversions a day the server allows an anonymous caller, read on the server. */
  dailyLimit: number;
  activeSourceFormat?: string;
  activeTargetFormat?: string;
  pair?: ConverterPair;
  activeQueueSummary?: QueueSummary;
}

function getEffectiveTargetFormat(chosen?: string, fallback?: string): string | undefined {
  if (chosen && chosen.toLowerCase() !== 'any') return chosen.toLowerCase();
  if (fallback && fallback.toLowerCase() !== 'any') return fallback.toLowerCase();
  return undefined;
}

function HomeTrustRow() {
  const t = useTranslations('hero.trust');
  const items = [
    { Icon: Files, text: t('formats', { count: REGISTRY_STATS.formatCount }) },
    { Icon: Lock, text: t('encrypted') },
    { Icon: UserRound, text: t('noSignup') },
  ];
  return (
    <ul className="mt-6 flex flex-wrap justify-center lg:justify-start gap-x-[18px] gap-y-2 text-sm font-extrabold text-ink-2">
      {items.map(({ Icon, text }) => (
        <li key={text} className="inline-flex items-center gap-2">
          <Icon aria-hidden="true" className="size-4 text-ink-3 shrink-0" />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Hero({
  onFilesSelected,
  hasActiveQueue,
  dailyLimit,
  activeSourceFormat,
  activeTargetFormat,
  pair,
  activeQueueSummary,
}: Readonly<HeroProps>) {
  const t = useTranslations('hero');
  const [sourceFormat, setSourceFormat] = useState(activeSourceFormat ? activeSourceFormat.toLowerCase() : 'any');
  const [targetFormat, setTargetFormat] = useState(activeTargetFormat ? activeTargetFormat.toLowerCase() : 'any');
  const [userChangedTiles, setUserChangedTiles] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetFormatRef = useRef(targetFormat);

  useEffect(() => {
    targetFormatRef.current = targetFormat;
  }, [targetFormat]);

  useEffect(() => {
    if (activeSourceFormat) setSourceFormat(activeSourceFormat.toLowerCase());
  }, [activeSourceFormat]);

  useEffect(() => {
    if (activeTargetFormat) {
      const normalized = activeTargetFormat.toLowerCase();
      setTargetFormat(normalized);
      targetFormatRef.current = normalized;
    }
  }, [activeTargetFormat]);

  // The home page names no pair: once its queue empties, the next files start from no target again.
  const hadActiveQueueRef = useRef(hasActiveQueue);
  useEffect(() => {
    const queueEmptied = hadActiveQueueRef.current && !hasActiveQueue;
    hadActiveQueueRef.current = hasActiveQueue;
    if (queueEmptied && !pair) {
      setSourceFormat('any');
      setTargetFormat('any');
      targetFormatRef.current = 'any';
    }
  }, [hasActiveQueue, pair]);

  const addFiles = (files: File[]) => {
    onFilesSelected(files, getEffectiveTargetFormat(targetFormatRef.current, activeTargetFormat));
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const pastedFiles = e.clipboardData?.files;
      if (pastedFiles && pastedFiles.length > 0) {
        e.preventDefault();
        addFilesRef.current(Array.from(pastedFiles));
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
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

  const title = computeHeroTitle(t, {
    categoryTitle: pair?.title,
    hasActiveQueue,
    activeSourceFormat,
    activeTargetFormat,
    sourceFormat,
    targetFormat,
    userChangedTiles,
  });
  const subtitle = computeHeroSubtitle(t, pair?.description, hasActiveQueue, sourceFormat, targetFormat, userChangedTiles);
  const queueSummaryText = describeQueueSummary(t, activeQueueSummary);

  const dropzone = (chips?: React.ReactNode) => (
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
      onImportFile={(file) => addFiles([file])}
      dailyLimit={dailyLimit}
    >
      {chips}
    </HeroDropzoneCard>
  );

  let body: React.ReactNode;
  if (hasActiveQueue) {
    body = (
      <section className="py-6 sm:py-8 border-b border-rule">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-3xl sm:text-4xl leading-tight text-ink">{title}</h1>
            {queueSummaryText && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-xs text-xs font-medium tabular-nums text-ink-2 border border-rule">
                {queueSummaryText}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-ink-2 max-w-2xl">{subtitle}</p>
        </div>
      </section>
    );
  } else if (pair) {
    body = (
      <section className="pt-10 pb-16 lg:pt-14 lg:pb-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="lg:flex lg:items-center lg:justify-between lg:gap-12">
            <div className="text-center lg:text-left lg:max-w-2xl">
              <h1 className="text-4xl sm:text-5xl leading-none text-ink">{title}</h1>
              <p className="mt-5 text-lg leading-relaxed text-ink-2">{subtitle}</p>
            </div>
            <div className="mt-8 lg:mt-0 flex justify-center shrink-0">
              <HeroFormatTiles
                sourceFormat={sourceFormat}
                targetFormat={targetFormat}
                onSourceChange={handleSourceChange}
                onTargetChange={handleTargetChange}
              />
            </div>
          </div>
          <div className="mt-10 lg:mt-12 max-w-2xl mx-auto">{dropzone()}</div>
        </div>
      </section>
    );
  } else {
    body = (
      <section className="pt-10 pb-16 lg:pt-14 lg:pb-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-14">
            <div className="text-center lg:text-left min-w-0 lg:pt-16">
              <h1 className="text-5xl sm:text-6xl lg:text-[78px] font-normal leading-[0.95] tracking-[-0.06em] text-ink">
                {title}
              </h1>
              <p className="mt-6 text-lg sm:text-xl leading-normal text-ink-3 max-w-xl mx-auto lg:mx-0">{subtitle}</p>
              <HomeTrustRow />
            </div>
            <div className="mt-10 lg:mt-0 min-w-0">{dropzone(<SourceChipPicker />)}</div>
          </div>
          <PopularConversions />
        </div>
      </section>
    );
  }

  return (
    <>
      <input
        id="main-file-input"
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label={t('fileInputLabel')}
        onChange={handleFileChange}
      />
      {body}
    </>
  );
}
