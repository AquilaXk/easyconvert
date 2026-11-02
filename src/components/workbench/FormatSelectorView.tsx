'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';
import type { FormatCategory, FormatDefinition } from '@/lib/types';
import { CATEGORY_ORDER } from '@/lib/registry-stats';

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

type CategoryTranslator = ReturnType<typeof useTranslations<'formatCategories'>>;

function isFormatCategory(value: string): value is FormatCategory {
  return (CATEGORY_ORDER as readonly string[]).includes(value);
}

function formatCategoryLabel(tCategory: CategoryTranslator, category: string): string {
  const key = category.toLowerCase();
  if (isFormatCategory(key)) return tCategory(key);
  return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

interface FormatListProps {
  hasNoSupportedFormats: boolean;
  displayedFormats: FormatDefinition[];
  showAnyOption: boolean;
  search: string;
  normalizedSelected: string | undefined;
  onChoose: (id: string) => void;
}

function FormatList({
  hasNoSupportedFormats,
  displayedFormats,
  showAnyOption,
  search,
  normalizedSelected,
  onChoose,
}: Readonly<FormatListProps>) {
  const t = useTranslations('formatSelector');
  if (hasNoSupportedFormats) {
    return (
      <div className="flex items-center justify-center h-full text-ink-3 text-xs text-center py-6">
        {t('noTargets')}
      </div>
    );
  }
  if (displayedFormats.length === 0 && !showAnyOption) {
    return (
      <div className="flex items-center justify-center h-full text-ink-3 text-xs text-center py-6">
        {t('noMatches', { search })}
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
            className={`min-h-[44px] sm:min-h-[40px] px-2 rounded-sm text-[13px] font-bold tracking-[0.02em] uppercase text-center border transition-colors cursor-pointer truncate ${
              isSelected
                ? 'bg-accent border-accent text-on-accent'
                : 'hover:bg-accent-soft text-ink border-rule hover:border-accent'
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
  const t = useTranslations('formatSelector');
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-rule">
      <span className="text-sm font-semibold text-ink">
        {title || t('defaultTitle')}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('close')}
        className="min-w-[44px] min-h-[44px] -mr-2 inline-flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
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
  const t = useTranslations('formatSelector');
  const tCategory = useTranslations('formatCategories');
  const normalizedSelected = selectedFormatId?.toLowerCase();
  const anyLabel = t('anyFormat');
  const showAnyOption =
    Boolean(allowAny) && (!search.trim() || anyLabel.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-rule bg-sunken/60 shrink-0">
        <Search className="w-4 h-4 text-ink-3 shrink-0" />
        <label htmlFor={inputId} className="sr-only">
          {t('searchLabel')}
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
          placeholder={t('searchPlaceholder')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full bg-transparent text-base text-ink placeholder-ink-3 rounded-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-0 px-2 inline-flex items-center justify-center text-xs font-medium text-ink-3 hover:text-ink rounded-sm cursor-pointer"
          >
            {t('clear')}
          </button>
        )}
      </div>

      <div className="flex h-60 min-h-0 flex-1 min-w-0">
        {!search.trim() && categories.length > 0 && (
          <div className="w-36 sm:w-40 border-r border-rule overflow-y-auto shrink-0 p-1.5 space-y-0.5 bg-sunken/40">
            {categories.map((cat) => {
              const isActive = cat.toLowerCase() === activeCategory.toLowerCase();
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => onSelectCategory(cat)}
                  className={`min-h-[44px] sm:min-h-[40px] w-full px-2.5 py-1.5 rounded-sm text-xs text-left flex items-center justify-between transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-accent-soft text-accent-ink font-semibold'
                      : 'text-ink-2 hover:bg-sunken hover:text-ink'
                  }`}
                >
                  <span className="truncate">{formatCategoryLabel(tCategory, cat)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 flex flex-col h-60 min-h-0 p-3 min-w-0">
          {showAnyOption && (
            <button
              type="button"
              onClick={() => onChoose('any')}
              className={`shrink-0 mb-2 min-h-[44px] sm:min-h-[40px] w-full px-3 rounded-sm text-[13px] font-bold tracking-[0.02em] uppercase border transition-colors cursor-pointer ${
                normalizedSelected === 'any' || !normalizedSelected
                  ? 'bg-accent border-accent text-on-accent'
                  : 'bg-sunken/70 border-rule text-ink hover:border-accent'
              }`}
            >
              {anyLabel}
            </button>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            <FormatList
              hasNoSupportedFormats={hasNoSupportedFormats}
              displayedFormats={displayedFormats}
              showAnyOption={showAnyOption}
              search={search}
              normalizedSelected={normalizedSelected}
              onChoose={onChoose}
            />
          </div>
        </div>
      </div>
    </>
  );
}
