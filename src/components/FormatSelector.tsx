'use client';

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import type { FormatDefinition } from '@/lib/types';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import { CATEGORY_ORDER } from '@/lib/registry-stats';
import { useModalDialog } from '@/hooks/useModalDialog';
import { FormatSelectorBody, MobileFormatDialogHeader } from './workbench/FormatSelectorView';

export interface FormatSelectorProps {
  availableFormats?: FormatDefinition[]; selectedFormatId?: string; sourceFormat?: string;
  allowAny?: boolean; onSelect: (formatId: string) => void; onClose: () => void; title?: string;
}

const NATURAL_PANEL_HEIGHT = 368;
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
const DESKTOP_PANEL_CLASS = 'm-0 p-0 right-auto w-[min(440px,calc(100dvw-2rem))] rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-xl overflow-hidden flex flex-col text-brand-950 dark:text-white text-left select-none';
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function readInitialMobileState(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 639px)').matches : false;
}

function sortFormatCategories(keys: Iterable<string>): string[] {
  const orderList = CATEGORY_ORDER as readonly string[];
  return Array.from(keys).sort((a, b) => {
    const idxA = orderList.indexOf(a.toLowerCase());
    const idxB = orderList.indexOf(b.toLowerCase());
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    return idxB !== -1 ? 1 : a.localeCompare(b);
  });
}

function pickValidCategory(cat: string | undefined, categories: string[]): string | null {
  return cat && categories.includes(cat) ? cat : null;
}

function resolveInitialCategory(selectedFormatId: string | undefined, sourceFormat: string | undefined, allFormats: FormatDefinition[], categories: string[]): string {
  const sel = selectedFormatId?.toLowerCase();
  if (sel && sel !== 'any') {
    const matched = pickValidCategory(allFormats.find((f) => f.id.toLowerCase() === sel)?.category, categories);
    if (matched) return matched;
  }
  const src = sourceFormat?.toLowerCase();
  if (src && src !== 'any') {
    const matched = pickValidCategory(FORMAT_REGISTRY[src]?.category, categories);
    if (matched) return matched;
  }
  return categories[0] || 'document';
}

function groupFormatsByCategory(allFormats: FormatDefinition[]): Map<string, FormatDefinition[]> {
  const map = new Map<string, FormatDefinition[]>();
  for (const fmt of allFormats) {
    const cat = fmt.category || 'document';
    const group = map.get(cat);
    if (group) group.push(fmt);
    else map.set(cat, [fmt]);
  }
  return map;
}

function filterDisplayedFormats(allFormats: FormatDefinition[], byCategory: Map<string, FormatDefinition[]>, activeCategory: string, search: string): FormatDefinition[] {
  const q = search.trim().toLowerCase();
  if (!q) return byCategory.get(activeCategory) || [];
  return allFormats.filter((f) => f.id.toLowerCase().includes(q) || f.name.toLowerCase().includes(q) || f.extension.toLowerCase().includes(q));
}

function resolveTriggerElement(anchor: HTMLSpanElement | null): HTMLElement | null {
  const sibling = anchor?.previousElementSibling;
  if (sibling instanceof HTMLElement) return sibling;
  const button = anchor?.parentElement?.querySelector<HTMLElement>('button');
  if (button) return button;
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
}

function shouldCloseOnTab(e: KeyboardEvent, popover: HTMLElement | null): boolean {
  if (e.key !== 'Tab' || !popover) return false;
  const focusables = Array.from(popover.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  if (focusables.length === 0) return true;
  return document.activeElement === (e.shiftKey ? focusables[0] : focusables[focusables.length - 1]);
}

function computeDesktopPortalPosition(triggerRect: DOMRect, viewportW: number, viewportH: number): React.CSSProperties | null {
  if (triggerRect.bottom <= 64 || triggerRect.top >= viewportH) return null;
  const panelWidth = Math.min(440, viewportW - 32);
  const left = Math.min(Math.max(12, triggerRect.left), Math.max(12, viewportW - panelWidth - 12));
  const spaceBelow = viewportH - triggerRect.bottom - 16;
  const spaceAbove = triggerRect.top - 72;
  if (spaceBelow >= NATURAL_PANEL_HEIGHT || spaceBelow >= spaceAbove) {
    return { top: triggerRect.bottom + 8, left, maxHeight: Math.max(180, Math.min(NATURAL_PANEL_HEIGHT, spaceBelow)) };
  }
  const effectiveHeight = Math.max(180, Math.min(NATURAL_PANEL_HEIGHT, spaceAbove));
  return { top: Math.max(72, triggerRect.top - effectiveHeight - 8), left, maxHeight: effectiveHeight };
}

export default function FormatSelector({
  availableFormats, selectedFormatId, sourceFormat, allowAny = false, onSelect, onClose, title,
}: Readonly<FormatSelectorProps>) {
  const inputId = useId();
  const [search, setSearch] = useState('');
  const [isMobile, setIsMobile] = useState(readInitialMobileState);
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({ top: 0, left: 12 });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDialogElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useModalDialog(dialogRef, isMobile, onClose);

  const allFormats = useMemo(() => (availableFormats !== undefined ? availableFormats : getAllFormats()), [availableFormats]);
  const categoriesWithFormats = useMemo(() => groupFormatsByCategory(allFormats), [allFormats]);
  const categories = useMemo(() => sortFormatCategories(categoriesWithFormats.keys()), [categoriesWithFormats]);
  const initialCategory = useMemo(
    () => resolveInitialCategory(selectedFormatId, sourceFormat, allFormats, categories),
    [selectedFormatId, sourceFormat, allFormats, categories]
  );
  const [activeCategory, setActiveCategory] = useState<string>(initialCategory);

  useEffect(() => { setActiveCategory(initialCategory); }, [initialCategory]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 639px)');
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (isMobile || typeof document === 'undefined') return;
    triggerRef.current = resolveTriggerElement(anchorRef.current);
    document.getElementById(inputId)?.focus({ preventScroll: true });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || shouldCloseOnTab(e, popoverRef.current)) {
        e.preventDefault();
        const trigger = triggerRef.current;
        onCloseRef.current();
        trigger?.focus({ preventScroll: true });
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || popoverRef.current?.contains(target) || anchorRef.current?.parentElement?.contains(target)) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isMobile, inputId]);

  useIsomorphicLayoutEffect(() => {
    if (isMobile || typeof window === 'undefined') return;
    const updatePosition = () => {
      const anchorEl = anchorRef.current?.parentElement;
      if (!anchorEl) return;
      const next = computeDesktopPortalPosition(anchorEl.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      if (!next) onCloseRef.current();
      else setPortalStyle(next);
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isMobile]);

  const displayedFormats = useMemo(
    () => filterDisplayedFormats(allFormats, categoriesWithFormats, activeCategory, search),
    [search, activeCategory, allFormats, categoriesWithFormats]
  );

  const handleSelect = (formatId: string) => {
    const trigger = triggerRef.current;
    onSelect(formatId);
    onCloseRef.current();
    if (!isMobile) trigger?.focus({ preventScroll: true });
  };

  const dialogLabel = title || 'Select Format';
  const body = (
    <FormatSelectorBody
      inputId={inputId} search={search} onSearchChange={setSearch} categories={categories}
      activeCategory={activeCategory} onSelectCategory={setActiveCategory} displayedFormats={displayedFormats}
      hasNoSupportedFormats={allFormats.length === 0} selectedFormatId={selectedFormatId}
      allowAny={allowAny} onChoose={handleSelect}
    />
  );

  if (isMobile) {
    return (
      <dialog
        ref={dialogRef} aria-label={dialogLabel}
        className="w-[calc(100dvw-1.5rem)] max-w-md rounded-xl p-0 bg-white dark:bg-dark-surface text-brand-950 dark:text-white border border-neutral-border dark:border-dark-border shadow-2xl overflow-hidden text-left select-none"
      >
        <MobileFormatDialogHeader title={title} onClose={onClose} />
        {body}
      </dialog>
    );
  }

  if (typeof document === 'undefined') {
    return (
      <dialog open ref={popoverRef} aria-label={dialogLabel} className={`relative ${DESKTOP_PANEL_CLASS}`}>
        {body}
      </dialog>
    );
  }

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {createPortal(
        <dialog open ref={popoverRef} aria-label={dialogLabel} style={portalStyle} className={`fixed z-[60] ${DESKTOP_PANEL_CLASS}`}>
          {body}
        </dialog>,
        document.body
      )}
    </>
  );
}
