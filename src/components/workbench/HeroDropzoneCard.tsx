'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Upload, HardDrive, Globe } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { PlumeMark } from './PlumeMark';
import { useFileLimitCopy } from '../i18n/format';
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

const POPULAR_PAIRS = [
  { key: 'pdfToWord', href: '/pdf-to-docx' },
  { key: 'wordToPdf', href: '/docx-to-pdf' },
  { key: 'imageToWebp', href: '/png-to-webp' },
  { key: 'videoToMp3', href: '/mp4-to-mp3' },
  { key: 'heicToJpg', href: '/heic-to-jpg' },
  { key: 'epubToPdf', href: '/epub-to-pdf' },
] as const;

export default function HeroDropzoneCard({
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenFileDialog,
  onOpenUrlModal,
}: Readonly<HeroDropzoneCardProps>) {
  const t = useTranslations('hero.dropzone');
  const tPairs = useTranslations('hero.popularPairs');
  const fileLimitCopy = useFileLimitCopy();
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
        className={`relative rounded-md border-2 border-dashed p-6 sm:p-8 text-center transition-colors duration-200 ${
          isDragOver ? 'border-accent bg-accent-soft' : 'border-accent-edge bg-surface shadow-elev-2'
        }`}
      >
        <PlumeMark className="size-11 mx-auto mb-2 text-accent-ink" />

        <p className="text-2xl font-semibold tracking-tight text-ink">
          {t('heading')}
        </p>
        <p className="text-sm text-ink-2 mt-1.5">
          {t('hint')}
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <div ref={splitButtonRef} className="relative inline-flex items-stretch rounded-sm">
            <button
              type="button"
              onClick={onOpenFileDialog}
              className="btn-primary min-h-[48px] px-6 font-semibold text-sm sm:text-base rounded-l-sm flex items-center gap-2 cursor-pointer"
            >
              <Upload className="w-4 h-4 shrink-0" />
              <span>{t('selectFile')}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowSourceMenu((v) => !v)}
              aria-label={t('moreSources')}
              aria-haspopup="menu"
              aria-expanded={showSourceMenu}
              className="btn-primary min-h-[48px] w-12 border-l border-on-accent/25 rounded-r-sm flex items-center justify-center cursor-pointer"
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform duration-200 ${showSourceMenu ? 'rotate-180' : ''}`}
              />
            </button>

            {showSourceMenu && (
              <div
                role="menu"
                aria-label={t('sourcesMenu')}
                className="absolute top-full right-0 mt-2 w-52 max-w-[calc(100dvw-2rem)] rounded-md bg-surface border border-rule shadow-elev-1 p-1.5 z-40 text-left"
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
                  <span>{t('fromDevice')}</span>
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
                  <span>{t('fromUrl')}</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onOpenUrlModal}
            className="transition-colors min-h-[44px] sm:min-h-[36px] px-3.5 rounded-sm text-xs font-medium text-ink-2 hover:text-ink border border-rule hover:border-rule-strong inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 shrink-0" />
            <span>{t('addFromUrl')}</span>
          </button>
        </div>

        <div className="mt-6 pt-4 border-t border-rule text-xs text-ink-3 tabular-nums flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <span>{t('formatsSupported', { count: REGISTRY_STATS.formatCount })}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{fileLimitCopy(plan)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{t('assurance')}</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs font-medium uppercase tracking-widest text-ink-3 mr-1">
          {t('popular')}
        </span>
        {POPULAR_PAIRS.map((pair) => (
          <Link
            key={pair.href}
            href={pair.href}
            className="transition-colors min-h-[44px] sm:min-h-[36px] px-3 py-1.5 rounded-sm text-xs font-medium text-ink-2 border border-rule hover:border-accent hover:text-accent-ink inline-flex items-center"
          >
            {tPairs(pair.key)}
          </Link>
        ))}
      </div>
    </div>
  );
}
