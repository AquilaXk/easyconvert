'use client';

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { FormatDefinition } from '@/lib/types';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import { CATEGORY_ORDER } from '@/lib/registry-stats';
import { canonicalFormat } from '@/lib/format-aliases';
import { FormatSelectorBody } from './workbench/FormatSelectorView';
import { usePopoverDismiss } from './workbench/usePopoverDismiss';

export interface FormatSelectorProps {
  /** The button the popover hangs from, where focus returns when it closes. */
  triggerRef: React.RefObject<HTMLElement | null>;
  availableFormats?: FormatDefinition[]; selectedFormatId?: string; sourceFormat?: string;
  onSelect: (formatId: string) => void; onClose: () => void; title?: string;
}

/** The reference popover: 352 px wide, 321 px tall (a 33 px search over a 288 px body), 2 px under its trigger. */
const PANEL_WIDTH = 352;
const PANEL_HEIGHT = 321;
const PANEL_GAP = 2;
const VIEWPORT_GUTTER = 8;
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
/** Under the sticky header (z-40) and over the pinned queue bar (z-30): it scrolls under the header with its trigger. */
const PANEL_CLASS = 'fixed z-[35] m-0 p-0 rounded-xs bg-surface border border-rule shadow-elev-1 overflow-hidden flex flex-col text-ink text-left select-none';
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

function resolveInitialCategory(currentFormatId: string | undefined, sourceFormat: string | undefined, allFormats: FormatDefinition[], categories: string[]): string {
  const valid = (cat: string | undefined) => (cat && categories.includes(cat) ? cat : null);
  const source = sourceFormat?.toLowerCase();
  return (
    valid(allFormats.find((f) => f.id === currentFormatId)?.category) ??
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

/** The formats a search names: by id, extension or name, and an alias offered alone by the format it stands for (tgz finds TAR.GZ). */
function filterDisplayedFormats(allFormats: FormatDefinition[], byCategory: Map<string, FormatDefinition[]>, activeCategory: string, search: string): FormatDefinition[] {
  const q = search.trim().toLowerCase();
  if (!q) return byCategory.get(activeCategory) || [];
  const named = canonicalFormat(q);
  return allFormats.filter((f) => canonicalFormat(f.id) === named || f.id.includes(q) || f.name.toLowerCase().includes(q) || f.extension.toLowerCase().includes(q));
}

function shouldCloseOnTab(e: KeyboardEvent, popover: HTMLElement | null): boolean {
  if (!popover) return false;
  const focusables = Array.from(popover.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  if (focusables.length === 0) return true;
  return document.activeElement === (e.shiftKey ? focusables[0] : focusables.at(-1));
}

/** The part of the screen a person sees, in the layout coordinates `getBoundingClientRect` reports. */
export interface VisibleArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the popover sits for a trigger at `triggerRect`, as Floating UI places a fixed element: in layout coordinates,
 * under the trigger and start-aligned, or above it when there is more room there, with `visible` (the visual viewport
 * below the header) deciding only the side, the horizontal clamp and the height. `layoutHeight` is the height of the
 * layout viewport, which a fixed `bottom` is measured from.
 */
export function computePopoverPosition(triggerRect: DOMRect, visible: VisibleArea, layoutHeight: number): React.CSSProperties {
  const width = Math.min(PANEL_WIDTH, visible.right - visible.left - 2 * VIEWPORT_GUTTER);
  const minLeft = visible.left + VIEWPORT_GUTTER;
  const left = Math.min(Math.max(minLeft, triggerRect.left), Math.max(minLeft, visible.right - width - VIEWPORT_GUTTER));
  const spaceBelow = visible.bottom - triggerRect.bottom - PANEL_GAP - VIEWPORT_GUTTER;
  const spaceAbove = triggerRect.top - PANEL_GAP - visible.top;
  const below = spaceBelow >= PANEL_HEIGHT || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(0, Math.min(PANEL_HEIGHT, below ? spaceBelow : spaceAbove));
  return below
    ? { top: triggerRect.bottom + PANEL_GAP, bottom: 'auto', left, width, maxHeight }
    : { top: 'auto', bottom: layoutHeight - triggerRect.top + PANEL_GAP, left, width, maxHeight };
}

/**
 * The visual viewport, which leaves out an on-screen keyboard and a pinch zoom, below the sticky header. For a fixed
 * element client coordinates are relative to the layout viewport in every engine, so the visual viewport sits at its
 * offsets there (Floating UI's `getViewportRect`).
 */
function visibleArea(): VisibleArea {
  const html = document.documentElement;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const headerBottom = document.querySelector('[data-sticky-header]')?.getBoundingClientRect().bottom ?? 0;
  return {
    left,
    top: Math.max(top, headerBottom),
    right: left + (viewport?.width ?? html.clientWidth),
    bottom: top + (viewport?.height ?? html.clientHeight),
  };
}

const POSITION_KEYS = ['top', 'bottom', 'left', 'width', 'maxHeight'] as const;
const samePosition = (a: React.CSSProperties, b: React.CSSProperties) => POSITION_KEYS.every((key) => a[key] === b[key]);

/**
 * Keeps the popover under its trigger as the page scrolls, the window resizes or an on-screen keyboard moves the visual
 * viewport. It follows the trigger off screen rather than closing, as the reference popover does; a scroll inside the
 * popover moves nothing.
 */
function usePopoverPlacement(
  triggerRef: React.RefObject<HTMLElement | null>,
  popoverRef: React.RefObject<HTMLDialogElement | null>,
  setPortalStyle: React.Dispatch<React.SetStateAction<React.CSSProperties>>
): void {
  useIsomorphicLayoutEffect(() => {
    const updatePosition = (event?: Event) => {
      const trigger = triggerRef.current;
      if (!trigger || (event?.target instanceof Node && popoverRef.current?.contains(event.target))) return;
      const next = computePopoverPosition(trigger.getBoundingClientRect(), visibleArea(), document.documentElement.clientHeight || window.innerHeight);
      setPortalStyle((current) => (samePosition(current, next) ? current : next));
    };
    updatePosition();
    const viewport = window.visualViewport;
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    viewport?.addEventListener('resize', updatePosition);
    viewport?.addEventListener('scroll', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      viewport?.removeEventListener('resize', updatePosition);
      viewport?.removeEventListener('scroll', updatePosition);
    };
  }, [triggerRef, popoverRef, setPortalStyle]);
}

/**
 * The format picker, as the reference converter draws it at every width: a popover anchored under its trigger with a
 * search field, a column of categories and a grid of formats, the current one filled with the primary colour. It opens
 * with the search focused, on a phone too, as the reference does.
 */
export default function FormatSelector({
  triggerRef, availableFormats, selectedFormatId, sourceFormat, onSelect, onClose, title,
}: Readonly<FormatSelectorProps>) {
  const t = useTranslations('formatSelector');
  const inputId = useId();
  const [search, setSearch] = useState('');
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({ top: 0, bottom: 'auto', left: VIEWPORT_GUTTER });
  const popoverRef = useRef<HTMLDialogElement>(null);

  const allFormats = useMemo(() => collapseAliases(availableFormats ?? getAllFormats()), [availableFormats]);
  const categoriesWithFormats = useMemo(() => groupFormatsByCategory(allFormats), [allFormats]);
  const categories = useMemo(() => sortFormatCategories(categoriesWithFormats.keys()), [categoriesWithFormats]);
  const currentFormatId = selectedFormatId ? canonicalFormat(selectedFormatId.toLowerCase()) : undefined;
  const initialCategory = useMemo(
    () => resolveInitialCategory(currentFormatId, sourceFormat, allFormats, categories),
    [currentFormatId, sourceFormat, allFormats, categories]
  );
  const [activeCategory, setActiveCategory] = useState<string>(initialCategory);

  useEffect(() => { setActiveCategory(initialCategory); }, [initialCategory]);
  useEffect(() => { document.getElementById(inputId)?.focus({ preventScroll: true }); }, [inputId]);
  usePopoverDismiss({
    isOpen: true,
    triggerRef,
    insideRefs: [popoverRef, triggerRef],
    leavesOnTab: (event) => shouldCloseOnTab(event, popoverRef.current),
    onClose,
  });
  usePopoverPlacement(triggerRef, popoverRef, setPortalStyle);

  const displayedFormats = useMemo(
    () => filterDisplayedFormats(allFormats, categoriesWithFormats, activeCategory, search),
    [search, activeCategory, allFormats, categoriesWithFormats]
  );

  const handleSelect = (formatId: string) => {
    onSelect(formatId);
    onClose();
    triggerRef.current?.focus({ preventScroll: true });
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
        currentFormatId={currentFormatId}
        onChoose={handleSelect}
      />
    </dialog>
  );

  if (typeof document === 'undefined') return panel;
  return createPortal(panel, document.body);
}
