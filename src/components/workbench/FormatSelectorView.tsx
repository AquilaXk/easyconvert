'use client';

import React from 'react';
import { Search, X } from 'lucide-react';
import type { FormatCategory, FormatDefinition } from '@/lib/types';
import { CATEGORY_LABELS } from '@/lib/registry-stats';

export interface FormatSelectorBodyProps {
  inputId: string;
  search: string;
  onSearchChange: (val: string) => void;
  categories: string[];
  activeCategory: string;
  onSelectCategory: (cat: string) => void;
  displayedFormats: FormatDefinition[];
  hasNoSupportedFormats: boolean;
  selectedFormatId?: string;
  allowAny?: boolean;
  onChoose: (id: string) => void;
}

export interface MobileFormatDialogHeaderProps {
  title?: string;
  onClose: () => void;
}

function formatCategoryLabel(category: string): string {
  const key = category.toLowerCase() as FormatCategory;
  if (key in CATEGORY_LABELS) {
    return CATEGORY_LABELS[key];
  }
  return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

function renderFormatList(
  hasNoSupportedFormats: boolean,
  displayedFormats: FormatDefinition[],
  showAnyOption: boolean,
  search: string,
  normalizedSelected: string | undefined,
  onChoose: (id: string) => void
): React.ReactNode {
  if (hasNoSupportedFormats) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted dark:text-dark-muted text-xs text-center py-6">
        No supported output formats for this file.
      </div>
    );
  }
  if (displayedFormats.length === 0 && !showAnyOption) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted dark:text-dark-muted text-xs text-center py-6">
        No formats matching &quot;{search}&quot;
      </div>
    );
  }
  return (
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
  );
}

export function MobileFormatDialogHeader({
  title,
  onClose,
}: Readonly<MobileFormatDialogHeaderProps>) {
  return (
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
  );
}

export function FormatSelectorBody({
  inputId,
  search,
  onSearchChange,
  categories,
  activeCategory,
  onSelectCategory,
  displayedFormats,
  hasNoSupportedFormats,
  selectedFormatId,
  allowAny,
  onChoose,
}: Readonly<FormatSelectorBodyProps>) {
  const normalizedSelected = selectedFormatId?.toLowerCase();
  const showAnyOption =
    Boolean(allowAny) && (!search.trim() || 'any format'.includes(search.trim().toLowerCase()));

  return (
    <>
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-neutral-border dark:border-dark-border bg-neutral-subtle/60 dark:bg-dark-elevated/60 shrink-0">
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
          className="w-full bg-transparent text-base text-brand-950 dark:text-white placeholder-ink-muted dark:placeholder-dark-muted rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-0 px-2 inline-flex items-center justify-center text-xs font-medium text-ink-muted hover:text-brand-950 dark:text-dark-muted dark:hover:text-white rounded-md cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex h-60 min-h-0 flex-1 min-w-0">
        {!search.trim() && categories.length > 0 && (
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

        <div className="flex-1 flex flex-col h-60 min-h-0 p-3 min-w-0 bg-white dark:bg-dark-surface">
          {showAnyOption && (
            <button
              type="button"
              onClick={() => onChoose('any')}
              className={`shrink-0 mb-2 min-h-[44px] sm:min-h-[40px] w-full px-3 rounded-md text-xs font-mono font-semibold uppercase border transition-colors cursor-pointer ${
                normalizedSelected === 'any' || !normalizedSelected
                  ? 'bg-brand-700 border-brand-700 text-white'
                  : 'bg-neutral-subtle/70 dark:bg-dark-elevated border-neutral-border dark:border-dark-border text-brand-950 dark:text-white hover:border-brand-600'
              }`}
            >
              ANY FORMAT
            </button>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            {renderFormatList(
              hasNoSupportedFormats,
              displayedFormats,
              showAnyOption,
              search,
              normalizedSelected,
              onChoose
            )}
          </div>
        </div>
      </div>
    </>
  );
}
