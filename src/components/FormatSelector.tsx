'use client';

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, hide, offset, platform, shift, size } from '@floating-ui/dom';
import { useTranslations } from 'next-intl';
import type { FormatDefinition } from '@/lib/types';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import { CATEGORY_ORDER } from '@/lib/registry-stats';
import { canonicalFormat } from '@/lib/format-aliases';
import { FormatSelectorBody } from './workbench/FormatSelectorView';
import { usePopoverDismiss } from './workbench/usePopoverDismiss';

/** What a picker offers and reports, which the button that opens it takes as its own props. */
export interface FormatChoiceProps {
  availableFormats?: FormatDefinition[]; selectedFormatId?: string; sourceFormat?: string;
  onSelect: (formatId: string) => void; title?: string;
}

export interface FormatSelectorProps extends FormatChoiceProps {
  /** The button the popover hangs from, where focus returns when it closes. */
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

/** The reference popover: 352 px wide, 321 px tall (a 33 px search over a 288 px body), 2 px under its trigger. */
const PANEL_WIDTH = 352;
const PANEL_HEIGHT = 321;
const PANEL_GAP = 2;
const VIEWPORT_GUTTER = 8;
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

/**
 * How far down the visible area starts: the bottom of the sticky header while it is in view. The header is read through
 * the platform of Floating UI, which puts it in the frame the trigger is placed in, so that WebKit's visual viewport offsets
 * are added to it as they are to the trigger.
 */
async function headerInset(popover: HTMLElement): Promise<number> {
  const header = document.querySelector('[data-sticky-header]');
  if (!header) return 0;
  const { reference } = await platform.getElementRects({ reference: header, floating: popover, strategy: 'fixed' });
  return Math.max(0, reference.y + reference.height - (window.visualViewport?.offsetTop ?? 0));
}

/**
 * Keeps the popover under its trigger as the page scrolls, the window resizes, an on-screen keyboard moves the visual
 * viewport or a row above it changes size. It places the popover as Floating UI places a fixed element: under the trigger,
 * above it when there is more room there, inside an 8 px gutter and the visual viewport below the sticky header, and no
 * taller than the room on its side. It follows the trigger off screen rather than closing, as the reference popover does;
 * the first placement alone is held below the header, so a popover never opens under it. When the popover has scrolled out
 * of view with focus inside, focus moves to the trigger.
 */
function usePopoverPlacement(triggerRef: React.RefObject<HTMLElement | null>, popoverRef: React.RefObject<HTMLDialogElement | null>): void {
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    popover.style.width = `${PANEL_WIDTH}px`;
    let alive = true;
    let placed = false;
    const update = async () => {
      const inset = await headerInset(popover);
      const padding = { top: inset, right: VIEWPORT_GUTTER, bottom: VIEWPORT_GUTTER, left: VIEWPORT_GUTTER };
      const { x, y, middlewareData } = await computePosition(trigger, popover, {
        strategy: 'fixed',
        placement: 'bottom-start',
        middleware: [
          offset(PANEL_GAP),
          flip({ padding, crossAxis: false, fallbackPlacements: ['top-start'] }),
          shift({ padding }),
          size({
            padding,
            apply: ({ availableWidth, availableHeight, elements }) => {
              Object.assign(elements.floating.style, {
                width: `${Math.min(PANEL_WIDTH, availableWidth)}px`,
                maxHeight: `${Math.max(0, Math.min(PANEL_HEIGHT, availableHeight))}px`,
              });
            },
          }),
          hide({ strategy: 'escaped', padding: { top: inset } }),
        ],
      });
      if (!alive) return;
      Object.assign(popover.style, { left: `${x}px`, top: `${placed ? y : Math.max(y, inset)}px` });
      placed = true;
      if (middlewareData.hide?.escaped && popover.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    };
    const stopUpdating = autoUpdate(trigger, popover, update);
    return () => {
      alive = false;
      stopUpdating();
    };
  }, [triggerRef, popoverRef]);
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
  usePopoverPlacement(triggerRef, popoverRef);

  const displayedFormats = useMemo(
    () => filterDisplayedFormats(allFormats, categoriesWithFormats, activeCategory, search),
    [search, activeCategory, allFormats, categoriesWithFormats]
  );

  const handleSelect = (formatId: string) => {
    onSelect(formatId);
    onClose();
    triggerRef.current?.focus();
  };

  const panel = (
    <dialog
      open ref={popoverRef} aria-label={title || t('defaultTitle')} className={PANEL_CLASS}
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
