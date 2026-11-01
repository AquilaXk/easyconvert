'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ChevronDown, Upload, HardDrive, Globe } from 'lucide-react';
import { PlumeMark } from './FeatherVane';
import { fileLimitCopy } from '@/lib/plan-limits';
import { useViewerPlan } from '@/hooks/useViewerPlan';
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

export default function HeroDropzoneCard({
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenFileDialog,
  onOpenUrlModal,
}: Readonly<HeroDropzoneCardProps>) {
  const [showSourceMenu, setShowSourceMenu] = useState(false);
  const plan = useViewerPlan();
  const splitButtonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSourceMenu) return;

    const handleOutside = (event: PointerEvent) => {
      if (splitButtonRef.current && !splitButtonRef.current.contains(event.target as Node)) {
        setShowSourceMenu(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowSourceMenu(false);
    };

    document.addEventListener('pointerdown', handleOutside);
    window.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      window.removeEventListener('keydown', handleKey);
    };
  }, [showSourceMenu]);

  return (
    <div className="max-w-[600px] mx-auto px-4 -mt-16 sm:-mt-20 relative z-20 pb-8">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`glass sheen-edge relative rounded-md border border-rule p-6 sm:p-8 text-center transition-[transform,box-shadow] duration-500 ease-spring ${
          isDragOver ? '-translate-y-[3px] shadow-float' : ''
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-sm border transition-[inset,border-color] duration-500 ease-spring ${
            isDragOver ? 'inset-1.5 border-accent' : 'inset-2.5 border-rule'
          }`}
        />
        <PlumeMark className={`size-11 mx-auto mb-2 text-accent-ink transition-transform duration-500 ease-spring ${isDragOver ? '-translate-y-1 -rotate-6' : ''}`} />

        <p className="font-display text-2xl sm:text-3xl text-ink">
          Select your file to convert
        </p>
        <p className="text-sm text-ink-2 mt-1.5">
          Drop files here, or paste from clipboard
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <div ref={splitButtonRef} className="relative inline-flex items-stretch rounded-sm">
            <button
              type="button"
              onClick={onOpenFileDialog}
              className="lift min-h-[48px] px-6 bg-accent hover:bg-accent-hover hover:shadow-glow active:bg-accent-press text-on-accent font-semibold text-sm sm:text-base rounded-l-sm flex items-center gap-2 cursor-pointer"
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
              className="lift min-h-[48px] w-12 bg-accent hover:bg-accent-hover hover:shadow-glow active:bg-accent-press text-on-accent border-l border-on-accent/25 rounded-r-sm flex items-center justify-center cursor-pointer"
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform duration-300 ease-spring ${showSourceMenu ? 'rotate-180' : ''}`}
              />
            </button>

            {showSourceMenu && (
              <div
                role="menu"
                aria-label="File sources"
                className="absolute top-full right-0 mt-2 w-52 max-w-[calc(100dvw-2rem)] rounded-md glass border border-rule shadow-elev-1 p-1.5 z-40 text-left"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowSourceMenu(false);
                    onOpenFileDialog();
                  }}
                  className="min-h-[44px] w-full px-3 rounded-sm text-sm font-medium text-ink hover:bg-sunken flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <HardDrive className="w-4 h-4 text-ink-3 shrink-0" />
                  <span>From Device</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowSourceMenu(false);
                    onOpenUrlModal();
                  }}
                  className="min-h-[44px] w-full px-3 rounded-sm text-sm font-medium text-ink hover:bg-sunken flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <Globe className="w-4 h-4 text-ink-3 shrink-0" />
                  <span>From URL</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onOpenUrlModal}
            className="lift min-h-[44px] sm:min-h-[36px] px-3.5 rounded-sm text-xs font-medium text-ink-2 hover:text-ink border border-rule hover:border-rule-strong inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 shrink-0" />
            <span>Add from URL</span>
          </button>
        </div>

        <div className="mt-6 pt-4 border-t border-rule text-xs text-ink-3 tabular-nums flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <span>{REGISTRY_STATS.formatCount} Formats Supported</span>
          <span aria-hidden="true">&middot;</span>
          <span>{fileLimitCopy(plan)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>Encrypted &amp; Ephemeral</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs font-medium uppercase tracking-widest text-ink-3 mr-1">
          Popular
        </span>
        {POPULAR_PAIRS.map((pair) => (
          <Link
            key={pair.href}
            href={pair.href}
            className="lift min-h-[44px] sm:min-h-[36px] px-3 py-1.5 rounded-sm text-xs font-medium text-ink-2 border border-rule hover:border-accent hover:text-accent-ink inline-flex items-center"
          >
            {pair.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
