'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ChevronDown, Upload, HardDrive, Globe } from 'lucide-react';
import { getEffectiveMaxFileSize } from '@/lib/client-converter';
import { REGISTRY_STATS } from '@/lib/registry-stats';

interface HeroDropzoneCardProps {
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onOpenFileDialog: () => void;
  onOpenUrlModal: () => void;
}

const POPULAR_PAIRS: readonly { label: string; href: string }[] = [
  { label: 'PDF to Word', href: '/pdf-to-docx' },
  { label: 'Word to PDF', href: '/docx-to-pdf' },
  { label: 'Image to WebP', href: '/png-to-webp' },
  { label: 'Video to MP3', href: '/mp4-to-mp3' },
  { label: 'HEIC to JPG', href: '/heic-to-jpg' },
  { label: 'EPUB to PDF', href: '/epub-to-pdf' },
];

const TWO_GIB = 2 * 1024 * 1024 * 1024;

export default function HeroDropzoneCard({
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenFileDialog,
  onOpenUrlModal,
}: Readonly<HeroDropzoneCardProps>) {
  const [showSourceMenu, setShowSourceMenu] = useState(false);
  const [maxSizeCopy, setMaxSizeCopy] = useState('Up to 2 GB (OPFS)');
  const splitButtonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMaxSizeCopy(getEffectiveMaxFileSize() >= TWO_GIB ? 'Up to 2 GB' : 'Up to 100 MB');
  }, []);

  useEffect(() => {
    if (!showSourceMenu) return;

    const handleOutside = (event: MouseEvent) => {
      if (splitButtonRef.current && !splitButtonRef.current.contains(event.target as Node)) {
        setShowSourceMenu(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowSourceMenu(false);
    };

    document.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKey);
    };
  }, [showSourceMenu]);

  return (
    <div className="max-w-[600px] mx-auto px-4 -mt-16 sm:-mt-20 relative z-20 pb-8">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-lg p-6 sm:p-8 text-center transition-colors ${
          isDragOver ? 'ring-2 ring-brand-700 bg-brand-50/40 dark:bg-brand-900/20' : ''
        }`}
      >
        <div className="size-12 rounded-lg bg-brand-50 dark:bg-white/10 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-white/10 inline-flex items-center justify-center mx-auto mb-3.5">
          <Upload className="w-5 h-5" />
        </div>

        <p className="text-lg sm:text-xl font-semibold text-brand-950 dark:text-white">
          Select your file to convert
        </p>
        <p className="text-sm text-ink-secondary dark:text-dark-muted mt-1">
          Drop files here, or paste from clipboard
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <div ref={splitButtonRef} className="relative inline-flex items-stretch rounded-md shadow-sm">
            <button
              type="button"
              onClick={onOpenFileDialog}
              className="min-h-[48px] px-6 bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white font-semibold text-sm sm:text-base rounded-l-md flex items-center gap-2 cursor-pointer transition-colors"
            >
              <Upload className="w-4 h-4 shrink-0" />
              <span>Select File</span>
            </button>

            <button
              type="button"
              onClick={() => setShowSourceMenu((v) => !v)}
              aria-label="More file sources"
              aria-haspopup="menu"
              aria-expanded={showSourceMenu}
              className="min-h-[48px] w-12 bg-brand-700 hover:bg-brand-800 active:bg-brand-900 text-white border-l border-white/20 rounded-r-md flex items-center justify-center cursor-pointer transition-colors"
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform duration-150 ${showSourceMenu ? 'rotate-180' : ''}`}
              />
            </button>

            {showSourceMenu && (
              <div
                role="menu"
                aria-label="File sources"
                className="absolute top-full right-0 mt-2 w-52 max-w-[calc(100dvw-2rem)] rounded-lg bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-xl p-1.5 z-40 text-left"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowSourceMenu(false);
                    onOpenFileDialog();
                  }}
                  className="min-h-[44px] w-full px-3 rounded-md text-sm font-medium text-brand-950 dark:text-white hover:bg-neutral-subtle dark:hover:bg-white/10 flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <HardDrive className="w-4 h-4 text-ink-muted dark:text-dark-muted shrink-0" />
                  <span>From Device</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowSourceMenu(false);
                    onOpenUrlModal();
                  }}
                  className="min-h-[44px] w-full px-3 rounded-md text-sm font-medium text-brand-950 dark:text-white hover:bg-neutral-subtle dark:hover:bg-white/10 flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <Globe className="w-4 h-4 text-ink-muted dark:text-dark-muted shrink-0" />
                  <span>From URL</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onOpenUrlModal}
            className="min-h-[44px] sm:min-h-[36px] px-3.5 rounded-md text-xs font-medium bg-neutral-subtle hover:bg-neutral-border/60 dark:bg-dark-elevated dark:hover:bg-white/10 text-ink-secondary dark:text-slate-200 border border-neutral-border dark:border-dark-border inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 shrink-0" />
            <span>Add from URL</span>
          </button>
        </div>

        <div className="mt-5 pt-4 border-t border-neutral-border/70 dark:border-dark-border text-xs text-ink-muted dark:text-dark-muted flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <span>{REGISTRY_STATS.formatCount} Formats Supported</span>
          <span aria-hidden="true">&middot;</span>
          <span>{maxSizeCopy}</span>
          <span aria-hidden="true">&middot;</span>
          <span>Encrypted &amp; Ephemeral</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs font-semibold text-ink-muted dark:text-dark-muted mr-1">
          Popular
        </span>
        {POPULAR_PAIRS.map((pair) => (
          <Link
            key={pair.href}
            href={pair.href}
            className="min-h-[44px] sm:min-h-[36px] px-3 py-1.5 rounded-md text-xs font-medium bg-white dark:bg-dark-surface text-ink-secondary dark:text-slate-300 border border-neutral-border dark:border-dark-border hover:border-brand-600 hover:text-brand-700 dark:hover:text-white inline-flex items-center transition-colors"
          >
            {pair.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
