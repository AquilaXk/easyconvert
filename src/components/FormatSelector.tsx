'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Search, ChevronRight } from 'lucide-react';
import { FormatDefinition } from '@/lib/types';
import { getAllFormats } from '@/lib/registry';

interface FormatSelectorProps {
  availableFormats?: FormatDefinition[];
  selectedFormatId?: string;
  onSelect: (formatId: string) => void;
  onClose: () => void;
  title?: string;
}

export default function FormatSelector({
  availableFormats,
  selectedFormatId,
  onSelect,
  onClose,
}: FormatSelectorProps) {
  const [search, setSearch] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  const allFormats = availableFormats && availableFormats.length > 0 ? availableFormats : getAllFormats();

  // Group formats by category
  const categoriesWithFormats = useMemo(() => {
    const map = new Map<string, FormatDefinition[]>();
    allFormats.forEach((f) => {
      const cat = f.category || 'document';
      if (!map.has(cat)) {
        map.set(cat, []);
      }
      map.get(cat)!.push(f);
    });
    return map;
  }, [allFormats]);

  // Alphabetically sorted category list for format selection popover
  const categories = useMemo(() => {
    return Array.from(categoriesWithFormats.keys()).sort((a, b) => a.localeCompare(b));
  }, [categoriesWithFormats]);

  // Determine initial active category based on selectedFormatId
  const initialCategory = useMemo(() => {
    if (selectedFormatId) {
      const found = allFormats.find((f) => f.id.toLowerCase() === selectedFormatId.toLowerCase());
      if (found && categories.includes(found.category)) {
        return found.category;
      }
    }
    if (categories.includes('document')) return 'document';
    return categories[0] || 'document';
  }, [selectedFormatId, allFormats, categories]);

  const [activeCategory, setActiveCategory] = useState<string>(initialCategory);

  useEffect(() => {
    setActiveCategory(initialCategory);
  }, [initialCategory]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Capitalize category name (e.g. document -> Document, cad -> Cad)
  const formatCategoryName = (cat: string) => {
    if (cat.toLowerCase() === 'cad') return 'CAD';
    if (cat.toLowerCase() === 'ebook') return 'Ebook';
    return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
  };

  // Formats to display in right column
  const displayedFormats = useMemo(() => {
    if (search.trim()) {
      const q = search.toLowerCase();
      return allFormats.filter(
        (f) =>
          f.id.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q) ||
          f.extension.toLowerCase().includes(q)
      );
    }
    return categoriesWithFormats.get(activeCategory) || [];
  }, [search, activeCategory, allFormats, categoriesWithFormats]);

  return (
    <div
      ref={popoverRef}
      onClick={(e) => e.stopPropagation()}
      className="w-[420px] max-w-[95vw] bg-white dark:bg-[#14182B] border border-neutral-border dark:border-[#2B3556] rounded-2xl shadow-2xl overflow-hidden flex flex-col text-brand-950 dark:text-white animate-in zoom-in-95 duration-150 text-left select-none ring-1 ring-black/5 dark:ring-white/10"
    >
      {/* Top: Search Format Input */}
      <div className="flex items-center px-3.5 py-2.5 border-b border-neutral-border dark:border-[#252D48] bg-neutral-50 dark:bg-[#111424]">
        <Search className="w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0 mr-2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Format"
          autoFocus
          className="bg-transparent text-sm text-brand-950 dark:text-white placeholder-ink-muted dark:placeholder-neutral-400 outline-none w-full"
        />
      </div>

      {/* Two columns body */}
      <div className="flex h-72">
        {/* Left column: Category list */}
        {!search && (
          <div className="w-[130px] border-r border-neutral-border dark:border-[#252D48] py-1.5 overflow-y-auto shrink-0 bg-neutral-50/80 dark:bg-[#0E1120]">
            {categories.map((cat) => {
              const isActive = cat.toLowerCase() === activeCategory.toLowerCase();
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setActiveCategory(cat)}
                  onMouseEnter={() => setActiveCategory(cat)}
                  className={`flex items-center justify-between w-full px-3 py-2 text-xs text-left transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-brand-100 text-brand-900 font-bold border-l-2 border-brand-700 dark:bg-brand-700/20 dark:text-brand-200 dark:border-brand-500'
                      : 'text-ink-secondary hover:bg-neutral-100 hover:text-brand-950 dark:text-neutral-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
                  }`}
                >
                  <span className="truncate">{formatCategoryName(cat)}</span>
                  {isActive && <ChevronRight className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400 shrink-0" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Right column: Format badges */}
        <div className="flex-1 p-3 overflow-y-auto bg-white dark:bg-[#14182B]">
          {displayedFormats.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-ink-muted dark:text-neutral-400 text-xs text-center py-8">
              No formats matching &quot;{search}&quot;
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {displayedFormats.map((fmt) => {
                const isSelected = selectedFormatId?.toLowerCase() === fmt.id.toLowerCase();
                return (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => {
                      onSelect(fmt.id);
                      onClose();
                    }}
                    className={`px-3 py-2 text-xs font-mono font-semibold rounded-xl text-center border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-brand-700 border-brand-700 text-white shadow-md shadow-brand-700/30'
                        : 'bg-neutral-50 hover:bg-brand-50 text-brand-950 hover:text-brand-700 border-neutral-border hover:border-brand-400 dark:bg-[#1A2035] dark:hover:bg-brand-700/20 dark:text-neutral-200 dark:hover:text-white dark:border-[#2B3556] dark:hover:border-brand-500/40'
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
    </div>
  );
}
