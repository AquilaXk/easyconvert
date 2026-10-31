'use client';

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { Search, X } from 'lucide-react';
import type { FormatCategory, FormatDefinition } from '@/lib/types';
import { FORMAT_REGISTRY, getAllFormats } from '@/lib/registry';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/registry-stats';

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

function formatCategoryLabel(category: string): string {
  const key = category.toLowerCase() as FormatCategory;
  if (key in CATEGORY_LABELS) {
    return CATEGORY_LABELS[key];
  }
  return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

interface SelectorBodyProps {
  inputId: string;
  search: string;
  onSearchChange: (val: string) => void;
  categories: string[];
  activeCategory: string;
  onSelectCategory: (cat: string) => void;
  displayedFormats: FormatDefinition[];
  selectedFormatId?: string;
  allowAny?: boolean;
  onChoose: (id: string) => void;
}

function FormatSelectorBody({
  inputId,
  search,
  onSearchChange,
  categories,
  activeCategory,
  onSelectCategory,
  displayedFormats,
  selectedFormatId,
  allowAny,
  onChoose,
}: SelectorBodyProps) {
  const normalizedSelected = selectedFormatId?.toLowerCase();
  const showAnyOption =
    Boolean(allowAny) &&
    (!search.trim() || 'any format'.includes(search.trim().toLowerCase()));

  return (
    <>
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-neutral-border dark:border-dark-border bg-neutral-subtle/60 dark:bg-dark-elevated/60">
        <Search className="w-4 h-4 text-ink-muted dark:text-dark-muted shrink-0" />
        <label htmlFor={inputId} className="sr-only">
          Search format
        </label>
        <input
          id={inputId}
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && displayedFormats.length > 0) {
              e.preventDefault();
              onChoose(displayedFormats[0].id);
            }
          }}
          placeholder="Search format..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full bg-transparent text-base text-brand-950 dark:text-white placeholder-ink-muted dark:placeholder-dark-muted outline-none"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="min-h-[32px] px-2 text-xs font-medium text-ink-muted hover:text-brand-950 dark:text-dark-muted dark:hover:text-white rounded-md cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex h-72 sm:h-80 min-w-0">
        {!search.trim() && (
          <div className="w-36 sm:w-40 border-r border-neutral-border dark:border-dark-border overflow-y-auto shrink-0 p-1.5 space-y-0.5 bg-neutral-scaffold/70 dark:bg-[#141827]">
            {categories.map((cat) => {
              const isActive = cat.toLowerCase() === activeCategory.toLowerCase();
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => onSelectCategory(cat)}
                  className={`min-h-[44px] sm:min-h-[40px] w-full px-2.5 py-1.5 rounded-md text-xs text-left flex items-center justify-between transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-brand-50 text-brand-900 font-semibold dark:bg-white/10 dark:text-white'
                      : 'text-ink-secondary hover:bg-neutral-subtle hover:text-brand-950 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white'
                  }`}
                >
                  <span className="truncate">{formatCategoryLabel(cat)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 p-3 overflow-y-auto min-w-0 bg-white dark:bg-dark-surface">
          {showAnyOption && (
            <button
              type="button"
              onClick={() => onChoose('any')}
              className={`min-h-[44px] sm:min-h-[40px] w-full mb-2 px-3 rounded-md text-xs font-mono font-semibold uppercase border transition-colors cursor-pointer ${
                normalizedSelected === 'any' || !normalizedSelected
                  ? 'bg-brand-700 border-brand-700 text-white'
                  : 'bg-neutral-subtle/70 dark:bg-dark-elevated border-neutral-border dark:border-dark-border text-brand-950 dark:text-white hover:border-brand-600'
              }`}
            >
              ANY FORMAT
            </button>
          )}

          {displayedFormats.length === 0 && !showAnyOption ? (
            <div className="flex items-center justify-center h-full text-ink-muted dark:text-dark-muted text-xs text-center py-6">
              No formats matching &quot;{search}&quot;
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {displayedFormats.map((fmt) => {
                const isSelected = normalizedSelected === fmt.id.toLowerCase();
                return (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => onChoose(fmt.id)}
                    className={`min-h-[44px] sm:min-h-[40px] px-2 rounded-md text-xs font-mono font-semibold uppercase text-center border transition-colors cursor-pointer truncate ${
                      isSelected
                        ? 'bg-brand-700 border-brand-700 text-white'
                        : 'bg-neutral-scaffold dark:bg-dark-elevated hover:bg-brand-50 dark:hover:bg-white/10 text-brand-950 dark:text-slate-200 border-neutral-border dark:border-dark-border hover:border-brand-600'
                    }`}
                  >
                    {fmt.extension.toUpperCase()}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function FormatSelector({
  availableFormats,
  selectedFormatId,
  sourceFormat,
  allowAny = false,
  onSelect,
  onClose,
  title,
}: FormatSelectorProps) {
  const inputId = useId();
  const [search, setSearch] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [offsetX, setOffsetX] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const allFormats = useMemo(
    () => (availableFormats && availableFormats.length > 0 ? availableFormats : getAllFormats()),
    [availableFormats]
  );

  const categoriesWithFormats = useMemo(() => {
    const map = new Map<string, FormatDefinition[]>();
    for (const fmt of allFormats) {
      const cat = fmt.category || 'document';
      const group = map.get(cat);
      if (group) {
        group.push(fmt);
      } else {
        map.set(cat, [fmt]);
      }
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
      if (found && categories.includes(found.category)) {
        return found.category;
      }
    }
    if (sourceFormat && sourceFormat.toLowerCase() !== 'any') {
      const srcDef = FORMAT_REGISTRY[sourceFormat.toLowerCase()];
      if (srcDef && categories.includes(srcDef.category)) {
        return srcDef.category;
      }
    }
    return categories[0] || 'document';
  }, [selectedFormatId, sourceFormat, allFormats, categories]);

  const [activeCategory, setActiveCategory] = useState<string>(initialCategory);

  useEffect(() => {
    setActiveCategory(initialCategory);
  }, [initialCategory]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }
  }, [isMobile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useIsomorphicLayoutEffect(() => {
    if (isMobile) {
      setOffsetX(0);
      return;
    }

    const clampHorizontal = () => {
      const el = popoverRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const naturalLeft = rect.left - offsetX;
      const naturalRight = rect.right - offsetX;
      const maxRight = window.innerWidth - 12;
      let nextShift = 0;

      if (naturalRight > maxRight) {
        nextShift = maxRight - naturalRight;
      }
      if (naturalLeft + nextShift < 12) {
        nextShift = 12 - naturalLeft;
      }
      if (Math.abs(nextShift - offsetX) > 0.5) {
        setOffsetX(nextShift);
      }
    };

    clampHorizontal();
    window.addEventListener('resize', clampHorizontal);
    return () => window.removeEventListener('resize', clampHorizontal);
  }, [isMobile, offsetX]);

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

  if (isMobile) {
    return (
      <dialog
        ref={dialogRef}
        aria-label={title || 'Select Format'}
        onClose={onClose}
        onClick={(e) => {
          e.stopPropagation();
          if (e.target === dialogRef.current) onClose();
        }}
        className="w-[calc(100dvw-1.5rem)] max-w-md rounded-xl p-0 bg-white dark:bg-dark-surface text-brand-950 dark:text-white border border-neutral-border dark:border-dark-border shadow-2xl overflow-hidden text-left select-none"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-border dark:border-dark-border">
          <span className="text-sm font-semibold text-brand-950 dark:text-white">
            {title || 'Select Format'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close format selector"
            className="min-w-[44px] min-h-[44px] -mr-2 inline-flex items-center justify-center rounded-md text-ink-secondary dark:text-slate-300 hover:text-brand-950 dark:hover:text-white hover:bg-neutral-subtle dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <FormatSelectorBody
          inputId={inputId}
          search={search}
          onSearchChange={setSearch}
          categories={categories}
          activeCategory={activeCategory}
          onSelectCategory={setActiveCategory}
          displayedFormats={displayedFormats}
          selectedFormatId={selectedFormatId}
          allowAny={allowAny}
          onChoose={handleChoose}
        />
      </dialog>
    );
  }

  return (
    <div
      ref={popoverRef}
      onClick={(e) => e.stopPropagation()}
      style={offsetX !== 0 ? { transform: `translateX(${offsetX}px)` } : undefined}
      className="w-[min(440px,calc(100dvw-2rem))] rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-xl overflow-hidden flex flex-col text-brand-950 dark:text-white text-left select-none"
    >
      <FormatSelectorBody
        inputId={inputId}
        search={search}
        onSearchChange={setSearch}
        categories={categories}
        activeCategory={activeCategory}
        onSelectCategory={setActiveCategory}
        displayedFormats={displayedFormats}
        selectedFormatId={selectedFormatId}
        allowAny={allowAny}
        onChoose={handleChoose}
      />
    </div>
  );
}
