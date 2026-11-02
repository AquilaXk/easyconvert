'use client';

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { FormatDefinition } from '@/lib/types';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import { CATEGORY_ORDER } from '@/lib/registry-stats';
import { canonicalFormat } from '@/lib/format-aliases';
import { FormatSelectorBody } from './workbench/FormatSelectorView';

export interface FormatSelectorProps {
  availableFormats?: FormatDefinition[]; selectedFormatId?: string; sourceFormat?: string;
  onSelect: (formatId: string) => void; onClose: () => void; title?: string;
}

/** The reference popover: 352 px wide, 321 px tall (a 33 px search over a 288 px body), 2 px under its trigger. */
const PANEL_WIDTH = 352;
const PANEL_HEIGHT = 321;
const PANEL_GAP = 2;
const VIEWPORT_GUTTER = 8;
const MIN_PANEL_HEIGHT = 180;
/** The sticky header covers the top 64 px; a trigger scrolled under it closes the popover. */
const HEADER_BOTTOM = 64;
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
const PANEL_CLASS = 'fixed z-[60] m-0 p-0 rounded-xs bg-surface border border-rule shadow-elev-1 overflow-hidden flex flex-col text-ink text-left select-none';
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

/** Each format once, by its own name: an alias whose format is also offered folds into it, as the reference lists JPG alone. */
function collapseAliases(formats: FormatDefinition[]): FormatDefinition[] {
  const offered = new Set(formats.map((f) => f.id));
  return formats.filter((f) => canonicalFormat(f.id) === f.id || !offered.has(canonicalFormat(f.id)));
}

function resolveInitialCategory(selectedFormatId: string | undefined, sourceFormat: string | undefined, allFormats: FormatDefinition[], categories: string[]): string {
  const valid = (cat: string | undefined) => (cat && categories.includes(cat) ? cat : null);
  const selected = selectedFormatId ? canonicalFormat(selectedFormatId.toLowerCase()) : undefined;
  const source = sourceFormat?.toLowerCase();
  return (
    valid(allFormats.find((f) => f.id === selected)?.category) ??
    valid(source ? FORMAT_REGISTRY[source]?.category : undefined) ??
    categories[0] ??
    'document'
  );
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
  const named = canonicalFormat(q);
  return allFormats.filter((f) => f.id === named || f.id.includes(q) || f.name.toLowerCase().includes(q) || f.extension.toLowerCase().includes(q));
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
  return document.activeElement === (e.shiftKey ? focusables[0] : focusables.at(-1));
}

/**
 * Where the popover sits for a trigger at `triggerRect`: under it, start-aligned and kept inside the viewport, or above it
 * when there is more room there; null once the trigger has left the screen.
 */
export function computePopoverPosition(triggerRect: DOMRect, viewportW: number, viewportH: number): React.CSSProperties | null {
  if (triggerRect.bottom <= HEADER_BOTTOM || triggerRect.top >= viewportH) return null;
  const width = Math.min(PANEL_WIDTH, viewportW - 2 * VIEWPORT_GUTTER);
  const left = Math.min(Math.max(VIEWPORT_GUTTER, triggerRect.left), Math.max(VIEWPORT_GUTTER, viewportW - width - VIEWPORT_GUTTER));
  const spaceBelow = viewportH - triggerRect.bottom - PANEL_GAP - VIEWPORT_GUTTER;
  const spaceAbove = triggerRect.top - HEADER_BOTTOM - PANEL_GAP;
  const below = spaceBelow >= PANEL_HEIGHT || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(PANEL_HEIGHT, below ? spaceBelow : spaceAbove));
  return below
    ? { top: triggerRect.bottom + PANEL_GAP, bottom: 'auto', left, width, maxHeight }
    : { top: 'auto', bottom: viewportH - triggerRect.top + PANEL_GAP, left, width, maxHeight };
}

/** The height left above an on-screen keyboard, which the visual viewport reports and the layout viewport does not. */
function visibleViewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

interface PopoverRefs {
  anchorRef: React.RefObject<HTMLSpanElement | null>;
  popoverRef: React.RefObject<HTMLDialogElement | null>;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  onCloseRef: React.MutableRefObject<() => void>;
}

/**
 * Focus, dismissal and placement of the popover. It never closes on a blur, since WebKit blurs the search on a mouse press
 * without focusing what was pressed; Escape, Tab out of it, a pointer press outside it, or its trigger leaving the screen
 * close it.
 */
function usePopoverEffects(inputId: string, refs: PopoverRefs, setPortalStyle: React.Dispatch<React.SetStateAction<React.CSSProperties>>): void {
  const { anchorRef, popoverRef, triggerRef, onCloseRef } = refs;

  useEffect(() => {
    triggerRef.current = resolveTriggerElement(anchorRef.current);
    document.getElementById(inputId)?.focus({ preventScroll: true });

    const closeToTrigger = () => {
      const trigger = triggerRef.current;
      onCloseRef.current();
      trigger?.focus({ preventScroll: true });
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeToTrigger();
        return;
      }
      if (!shouldCloseOnTab(e, popoverRef.current)) return;
      if (e.shiftKey) {
        e.preventDefault();
        closeToTrigger();
        return;
      }
      triggerRef.current?.focus({ preventScroll: true });
      onCloseRef.current();
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
  }, [inputId, anchorRef, popoverRef, triggerRef, onCloseRef]);

  useIsomorphicLayoutEffect(() => {
    const updatePosition = () => {
      const anchorEl = anchorRef.current?.parentElement;
      if (!anchorEl) return;
      const next = computePopoverPosition(anchorEl.getBoundingClientRect(), window.innerWidth, visibleViewportHeight());
      if (!next) onCloseRef.current();
      else setPortalStyle(next);
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
    };
  }, [anchorRef, onCloseRef, setPortalStyle]);
}

/**
 * The format picker, as the reference converter draws it at every width: a popover anchored under its trigger with a
 * search field, a column of categories and a grid of formats, the current one filled with the primary colour.
 */
export default function FormatSelector({
  availableFormats, selectedFormatId, sourceFormat, onSelect, onClose, title,
}: Readonly<FormatSelectorProps>) {
  const t = useTranslations('formatSelector');
  const inputId = useId();
  const [search, setSearch] = useState('');
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({ top: 0, bottom: 'auto', left: VIEWPORT_GUTTER });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const allFormats = useMemo(() => collapseAliases(availableFormats ?? getAllFormats()), [availableFormats]);
  const categoriesWithFormats = useMemo(() => groupFormatsByCategory(allFormats), [allFormats]);
  const categories = useMemo(() => sortFormatCategories(categoriesWithFormats.keys()), [categoriesWithFormats]);
  const initialCategory = useMemo(
    () => resolveInitialCategory(selectedFormatId, sourceFormat, allFormats, categories),
    [selectedFormatId, sourceFormat, allFormats, categories]
  );
  const [activeCategory, setActiveCategory] = useState<string>(initialCategory);

  useEffect(() => { setActiveCategory(initialCategory); }, [initialCategory]);

  usePopoverEffects(inputId, { anchorRef, popoverRef, triggerRef, onCloseRef }, setPortalStyle);

  const displayedFormats = useMemo(
    () => filterDisplayedFormats(allFormats, categoriesWithFormats, activeCategory, search),
    [search, activeCategory, allFormats, categoriesWithFormats]
  );

  const handleSelect = (formatId: string) => {
    const trigger = triggerRef.current;
    onSelect(formatId);
    onCloseRef.current();
    trigger?.focus({ preventScroll: true });
  };

  const panel = (
    <dialog
      open ref={popoverRef} aria-label={title || t('defaultTitle')} style={portalStyle} className={PANEL_CLASS}
      onMouseDown={(event) => {
        // WebKit moves focus nowhere on a press, so keep it where it is; the search itself still takes a press.
        if ((event.target as HTMLElement).id !== inputId) event.preventDefault();
      }}
    >
      <FormatSelectorBody
        inputId={inputId} search={search} onSearchChange={setSearch} categories={categories}
        activeCategory={activeCategory} onSelectCategory={setActiveCategory} displayedFormats={displayedFormats}
        hasNoSupportedFormats={allFormats.length === 0}
        currentFormatId={selectedFormatId ? canonicalFormat(selectedFormatId.toLowerCase()) : undefined}
        onChoose={handleSelect}
      />
    </dialog>
  );

  if (typeof document === 'undefined') return panel;
  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {createPortal(panel, document.body)}
    </>
  );
}
