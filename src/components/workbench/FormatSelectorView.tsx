'use client';

import React, { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Search } from 'lucide-react';
import type { FormatCategory, FormatDefinition } from '@/lib/types';
import { CATEGORY_ORDER } from '@/lib/registry-stats';
import { canonicalFormat } from '@/lib/format-aliases';

export interface FormatSelectorBodyProps {
  inputId: string;
  search: string;
  onSearchChange: (val: string) => void;
  categories: string[];
  activeCategory: string;
  onSelectCategory: (cat: string) => void;
  displayedFormats: FormatDefinition[];
  hasNoSupportedFormats: boolean;
  /** The format the trigger shows, by its own name (an alias already folded). */
  currentFormatId?: string;
  onChoose: (id: string) => void;
}

type CategoryTranslator = ReturnType<typeof useTranslations<'formatCategories'>>;

/** The grid has three columns, so a row up or down is three formats away. */
const GRID_COLUMNS = 3;

function isFormatCategory(value: string): value is FormatCategory {
  return (CATEGORY_ORDER as readonly string[]).includes(value);
}

function formatCategoryLabel(tCategory: CategoryTranslator, category: string): string {
  const key = category.toLowerCase();
  if (isFormatCategory(key)) return tCategory(key);
  return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

/** The format a key moves focus to from `current` in a grid of `count`, or 'search' above the first row, or null. */
function gridTarget(key: string, current: number, count: number): number | 'search' | null {
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: GRID_COLUMNS, ArrowUp: -GRID_COLUMNS }[key];
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (step === undefined) return null;
  const next = current + step;
  if (next < 0) return key === 'ArrowUp' ? 'search' : null;
  return next < count ? next : null;
}

const isPrintableKey = (event: React.KeyboardEvent) =>
  event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

function EmptyMessage({ children }: Readonly<{ children: React.ReactNode }>) {
  return <p className="flex items-center justify-center h-full px-3 text-ink-3 text-sm text-center">{children}</p>;
}

/**
 * The body of the reference popover: a search field ruled off at the bottom, then a column of categories beside a grid of
 * small format buttons, three to a row, the current format filled with the primary colour. The arrow keys move through the
 * grid, a letter typed on a format goes to the search, and Enter in the search takes the first match.
 */
export function FormatSelectorBody({
  inputId, search, onSearchChange, categories, activeCategory, onSelectCategory, displayedFormats, hasNoSupportedFormats,
  currentFormatId, onChoose,
}: Readonly<FormatSelectorBodyProps>) {
  const t = useTranslations('formatSelector');
  const tCategory = useTranslations('formatCategories');
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const formatButtons = () => Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-format]') ?? []);

  const handleSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && displayedFormats.length > 0) {
      event.preventDefault();
      onChoose(displayedFormats[0].id);
    } else if (event.key === 'ArrowDown' && displayedFormats.length > 0) {
      event.preventDefault();
      formatButtons()[0]?.focus();
    }
  };

  const handleGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isPrintableKey(event)) {
      event.preventDefault();
      onSearchChange(search + event.key);
      inputRef.current?.focus();
      return;
    }
    const buttons = formatButtons();
    const target = gridTarget(event.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length);
    if (target === null) return;
    event.preventDefault();
    if (target === 'search') inputRef.current?.focus();
    else buttons[target].focus();
  };

  const showCategories = !search.trim() && categories.length > 0;
  let grid: React.ReactNode;
  if (hasNoSupportedFormats) grid = <EmptyMessage>{t('noTargets')}</EmptyMessage>;
  else if (displayedFormats.length === 0) grid = <EmptyMessage>{t('noMatches', { search })}</EmptyMessage>;
  else {
    grid = (
      <div className="grid grid-cols-3 gap-1.5">
        {displayedFormats.map((fmt) => {
          const isCurrent = canonicalFormat(fmt.id) === currentFormatId;
          return (
            <button
              key={fmt.id}
              type="button"
              data-format={fmt.id}
              aria-current={isCurrent ? 'true' : undefined}
              onClick={() => onChoose(fmt.id)}
              className={`h-8 px-2 rounded-xs border text-xs font-semibold uppercase tracking-wide text-center truncate transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                isCurrent ? 'bg-accent border-accent text-on-accent' : 'border-rule text-ink-2 hover:bg-sunken hover:text-ink hover:border-rule-strong'
              }`}
            >
              {fmt.extension.toUpperCase()}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <div className="relative shrink-0">
        <Search aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-ink-3 pointer-events-none" />
        <label htmlFor={inputId} className="sr-only">
          {t('searchLabel')}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={handleSearchKey}
          placeholder={t('searchPlaceholder')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="block w-full py-1.5 pl-9 pr-2.5 bg-transparent text-sm text-ink border-0 border-b border-rule rounded-none focus-visible:outline-none focus-visible:border-accent"
        />
      </div>

      <div className="flex h-72 min-h-0 shrink">
        {showCategories && (
          <ul className="w-40 shrink-0 overflow-y-auto border-r border-rule py-1">
            {categories.map((cat) => {
              const isActive = cat.toLowerCase() === activeCategory.toLowerCase();
              return (
                <li key={cat}>
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => onSelectCategory(cat)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:bg-sunken focus-visible:text-ink ${
                      isActive ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken/60 hover:text-ink'
                    }`}
                  >
                    <span className="truncate">{formatCategoryLabel(tCategory, cat)}</span>
                    {isActive && <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-ink-3" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={gridRef} onKeyDown={handleGridKey} className="flex-1 min-w-0 overflow-y-auto p-2">
          {grid}
        </div>
      </div>
    </>
  );
}
