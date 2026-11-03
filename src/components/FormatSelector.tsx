'use client';

import React, { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, detectOverflow, flip, offset, platform, shift, size, type Middleware } from '@floating-ui/dom';
import { useTranslations } from 'next-intl';
import type { FormatDefinition } from '@/lib/types';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import { CATEGORY_ORDER } from '@/lib/registry-stats';
import { canonicalFormat, collapseAliases } from '@/lib/format-aliases';
import { FormatSelectorBody, formatLabel } from './workbench/FormatSelectorView';
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

const byLabel = (a: FormatDefinition, b: FormatDefinition) => {
  const [labelA, labelB] = [formatLabel(a), formatLabel(b)];
  if (labelA === labelB) return 0;
  return labelA < labelB ? -1 : 1;
};

/** The formats of each category, alphabetically by label, as the reference lists them. */
function groupFormatsByCategory(allFormats: FormatDefinition[]): Map<string, FormatDefinition[]> {
  const map = new Map<string, FormatDefinition[]>();
  for (const fmt of allFormats) {
    const cat = fmt.category || 'document';
    const group = map.get(cat);
    if (group) group.push(fmt);
    else map.set(cat, [fmt]);
  }
  for (const group of map.values()) group.sort(byLabel);
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
 * Whether the popover lies wholly outside the visible area: the viewport below the sticky header. It is the `escaped`
 * measure of the library's `hide` middleware (`packages/core/src/middleware/hide.ts`: the overflow on a side is at least
 * the size of the element) taken on the popover's own clipping ancestors, as `detectOverflow` does by default, instead of
 * those of its trigger, so that a clipping ancestor of the trigger cannot hide a popover that is on screen. Left and right
 * need no check, since `shift` keeps the popover inside them.
 */
const offscreen = (inset: number): Middleware => ({
  name: 'offscreen',
  async fn(state) {
    const overflow = await detectOverflow(state, { padding: { top: inset } });
    const { height } = state.rects.floating;
    return { data: { offscreen: overflow.top >= height || overflow.bottom >= height } };
  },
});

/**
 * Keeps the popover under its trigger as the page scrolls, the window resizes, an on-screen keyboard moves the visual
 * viewport or a row above it changes size. It places the popover as Floating UI places a fixed element: under the trigger,
 * above it when there is more room there, inside an 8 px gutter and the visual viewport below the sticky header, and no
 * taller than the room on its side, so that the popover of a trigger on screen never starts under the header. It follows
 * the trigger off screen rather than closing, as the reference popover does, and tells `onOffscreen` after each placement
 * that leaves it wholly out of view.
 */
function usePopoverPlacement(
  triggerRef: React.RefObject<HTMLElement | null>,
  popoverRef: React.RefObject<HTMLDialogElement | null>,
  onOffscreen: () => void
): void {
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    popover.style.width = `${PANEL_WIDTH}px`;
    let alive = true;
    const update = async () => {
      const inset = await headerInset(popover);
      if (!alive) return;
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
          offscreen(inset),
        ],
      });
      if (!alive) return;
      Object.assign(popover.style, { left: `${x}px`, top: `${y}px` });
      if (middlewareData.offscreen?.offscreen) onOffscreen();
    };
    const stopUpdating = autoUpdate(trigger, popover, update);
    return () => {
      alive = false;
      stopUpdating();
    };
  }, [triggerRef, popoverRef, onOffscreen]);
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

  const allFormats = useMemo(() => collapseAliases(availableFormats ?? getAllFormats(), (format) => format.id), [availableFormats]);
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
  const leaveOffscreenPopover = useCallback(() => {
    if (popoverRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
  }, [triggerRef]);
  usePopoverPlacement(triggerRef, popoverRef, leaveOffscreenPopover);

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
