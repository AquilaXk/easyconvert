'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Globe, HardDrive, Upload } from 'lucide-react';
import UrlImportModal from '../UrlImportModal';

/** How the split button reads: the drop zone's primary "select file" or the file bar's secondary "add more files". */
const VARIANTS = {
  primary: {
    main: 'btn-primary min-h-[48px] px-6 text-base sm:text-lg font-medium rounded-l-xs',
    toggle: 'btn-primary min-h-[48px] w-12 border-l border-on-accent/25 rounded-r-xs',
    menu: 'top-full mt-2',
  },
  secondary: {
    main: 'min-h-[44px] md:min-h-[40px] px-3.5 text-sm font-medium rounded-l-xs border border-rule bg-canvas text-ink hover:border-rule-strong',
    toggle: 'min-h-[44px] md:min-h-[40px] w-11 border border-l-0 border-rule bg-canvas text-ink rounded-r-xs hover:border-rule-strong',
    menu: 'bottom-full mb-2',
  },
} as const;

interface FileSourceButtonProps {
  label: string;
  variant: keyof typeof VARIANTS;
  disabled?: boolean;
  /** Opens the device file picker. */
  onPickDevice: () => void;
  /** Receives a file imported from a link. */
  onImportFile: (file: File) => void;
  className?: string;
}

/** A split button: the device picker on the main part, and a menu of the other file sources (device, link) on the chevron. */
export default function FileSourceButton({
  label, variant, disabled = false, onPickDevice, onImportFile, className = '',
}: Readonly<FileSourceButtonProps>) {
  const t = useTranslations('hero.dropzone');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const styles = VARIANTS[variant];

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleOutside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside);
    window.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      window.removeEventListener('keydown', handleKey);
    };
  }, [isMenuOpen]);

  const menuItemClass =
    'min-h-[44px] w-full px-3 rounded-xs text-sm font-medium text-ink hover:bg-sunken flex items-center gap-2.5 transition-colors cursor-pointer';

  return (
    <div ref={rootRef} className={`relative inline-flex items-stretch ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={onPickDevice}
        className={`${styles.main} flex-1 inline-flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <Upload aria-hidden="true" className="size-4 shrink-0" />
        <span>{label}</span>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsMenuOpen((open) => !open)}
        aria-label={t('moreSources')}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        className={`${styles.toggle} inline-flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <ChevronDown aria-hidden="true" className={`size-4 transition-transform duration-200 ${isMenuOpen ? 'rotate-180' : ''}`} />
      </button>

      {isMenuOpen && (
        <div
          role="menu"
          aria-label={t('sourcesMenu')}
          className={`absolute right-0 ${styles.menu} w-52 max-w-[calc(100dvw-2rem)] rounded-sm bg-surface border border-rule shadow-elev-1 p-1.5 z-40 text-left`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsMenuOpen(false);
              onPickDevice();
            }}
            className={menuItemClass}
          >
            <HardDrive aria-hidden="true" className="size-4 text-ink-3 shrink-0" />
            <span>{t('fromDevice')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsMenuOpen(false);
              setIsUrlModalOpen(true);
            }}
            className={menuItemClass}
          >
            <Globe aria-hidden="true" className="size-4 text-ink-3 shrink-0" />
            <span>{t('fromUrl')}</span>
          </button>
        </div>
      )}

      {isUrlModalOpen && (
        <UrlImportModal isOpen onAddFile={onImportFile} onClose={() => setIsUrlModalOpen(false)} />
      )}
    </div>
  );
}
