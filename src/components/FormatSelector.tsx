'use client';

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import type { FormatDefinition } from '@/lib/types';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import { CATEGORY_ORDER } from '@/lib/registry-stats';
import { useModalDialog } from '@/hooks/useModalDialog';
import { FormatSelectorBody, MobileFormatDialogHeader } from './workbench/FormatSelectorView';

export interface FormatSelectorProps {
  availableFormats?: FormatDefinition[];
  selectedFormatId?: string;
  sourceFormat?: string;
  allowAny?: boolean;
  onSelect: (formatId: string) => void;
  onClose: () => void;
  title?: string;
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const DESKTOP_PANEL_CLASS =
  'w-[min(440px,calc(100dvw-2rem))] rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-xl overflow-hidden flex flex-col text-brand-950 dark:text-white text-left select-none';

function readInitialMobileState(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 639px)').matches
    : false;
}

export default function FormatSelector({
  availableFormats,
  selectedFormatId,
  sourceFormat,
  allowAny = false,
  onSelect,
  onClose,
  title,
}: Readonly<FormatSelectorProps>) {
  const inputId = useId();
  const [search, setSearch] = useState('');
  const [isMobile, setIsMobile] = useState(readInitialMobileState);
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({ top: 0, left: 12 });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useModalDialog(dialogRef, isMobile, onClose);

  const allFormats = useMemo(
    () => (availableFormats !== undefined ? availableFormats : getAllFormats()),
    [availableFormats]
  );

  const categoriesWithFormats = useMemo(() => {
    const map = new Map<string, FormatDefinition[]>();
    for (const fmt of allFormats) {
      const cat = fmt.category || 'document';
      const group = map.get(cat);
      if (group) group.push(fmt);
      else map.set(cat, [fmt]);
    }
    return map;
  }, [allFormats]);

  const categories = useMemo(() => {
    const orderList = CATEGORY_ORDER as readonly string[];
    return Array.from(categoriesWithFormats.keys()).sort((a, b) => {
      const idxA = orderList.indexOf(a.toLowerCase());
      const idxB = orderList.indexOf(b.toLowerCase());
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [categoriesWithFormats]);

  const initialCategory = useMemo(() => {
    if (selectedFormatId && selectedFormatId.toLowerCase() !== 'any') {
      const found = allFormats.find((f) => f.id.toLowerCase() === selectedFormatId.toLowerCase());
      if (found && categories.includes(found.category)) return found.category;
    }
    if (sourceFormat && sourceFormat.toLowerCase() !== 'any') {
      const srcDef = FORMAT_REGISTRY[sourceFormat.toLowerCase()];
      if (srcDef && categories.includes(srcDef.category)) return srcDef.category;
    }
    return categories[0] || 'document';
  }, [selectedFormatId, sourceFormat, allFormats, categories]);

  const [activeCategory, setActiveCategory] = useState<string>(initialCategory);

  useEffect(() => {
    setActiveCategory(initialCategory);
  }, [initialCategory]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 639px)');
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (isMobile) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.parentElement?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isMobile, onClose]);

  useIsomorphicLayoutEffect(() => {
    if (isMobile || typeof window === 'undefined') return;

    const updatePosition = () => {
      const anchorEl = anchorRef.current?.parentElement;
      if (!anchorEl) return;
      const triggerRect = anchorEl.getBoundingClientRect();
      const panelRect = popoverRef.current?.getBoundingClientRect();
      const panelWidth =
        panelRect && panelRect.width > 0 ? panelRect.width : Math.min(440, window.innerWidth - 32);
      const panelHeight = panelRect && panelRect.height > 0 ? panelRect.height : 368;
      const maxLeft = Math.max(12, window.innerWidth - panelWidth - 12);
      const left = Math.min(Math.max(12, triggerRect.left), maxLeft);
      const overflowsBottom = triggerRect.bottom + panelHeight + 8 > window.innerHeight - 12;
      const fitsAbove = triggerRect.top - panelHeight - 8 >= 12;

      if (overflowsBottom && fitsAbove) {
        setPortalStyle({ top: triggerRect.top - panelHeight - 8, left });
      } else {
        setPortalStyle({
          top: triggerRect.bottom + 8,
          left,
          maxHeight: Math.max(220, window.innerHeight - triggerRect.bottom - 20),
        });
      }
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isMobile]);

  const displayedFormats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) {
      return allFormats.filter(
        (f) =>
          f.id.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q) ||
          f.extension.toLowerCase().includes(q)
      );
    }
    return categoriesWithFormats.get(activeCategory) || [];
  }, [search, activeCategory, allFormats, categoriesWithFormats]);

  const handleChoose = (formatId: string) => {
    onSelect(formatId);
    onClose();
  };

  const body = (
    <FormatSelectorBody
      inputId={inputId}
      search={search}
      onSearchChange={setSearch}
      categories={categories}
      activeCategory={activeCategory}
      onSelectCategory={setActiveCategory}
      displayedFormats={displayedFormats}
      hasNoSupportedFormats={allFormats.length === 0}
      selectedFormatId={selectedFormatId}
      allowAny={allowAny}
      onChoose={handleChoose}
    />
  );

  if (isMobile) {
    return (
      <dialog
        ref={dialogRef}
        aria-label={title || 'Select Format'}
        className="w-[calc(100dvw-1.5rem)] max-w-md rounded-xl p-0 bg-white dark:bg-dark-surface text-brand-950 dark:text-white border border-neutral-border dark:border-dark-border shadow-2xl overflow-hidden text-left select-none"
      >
        <MobileFormatDialogHeader title={title} onClose={onClose} />
        {body}
      </dialog>
    );
  }

  if (typeof document === 'undefined') {
    return (
      <div ref={popoverRef} className={DESKTOP_PANEL_CLASS}>
        {body}
      </div>
    );
  }

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {createPortal(
        <div ref={popoverRef} style={portalStyle} className={`fixed z-[60] ${DESKTOP_PANEL_CLASS}`}>
          {body}
        </div>,
        document.body
      )}
    </>
  );
}
