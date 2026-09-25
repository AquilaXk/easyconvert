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
    if (cat.toLowerCase() === 'cad') return 'Cad';
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
      className="w-[420px] max-w-[95vw] bg-[#18191d] border border-neutral-800 rounded-lg shadow-2xl overflow-hidden flex flex-col text-white animate-in zoom-in-95 duration-150 text-left select-none"
    >
      {/* Top: Search Format Input matching live_cc_format_popover.png */}
      <div className="flex items-center px-3 py-2 border-b border-neutral-800 bg-[#18191d]">
        <Search className="w-4 h-4 text-neutral-500 shrink-0 mr-2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Format"
          autoFocus
          className="bg-transparent text-sm text-white placeholder-neutral-500 outline-none w-full"
        />
      </div>

      {/* Two columns body */}
      <div className="flex h-72">
        {/* Left column (width ~140px, border-r border-neutral-800 py-1): Category list */}
        {!search && (
          <div className="w-[140px] border-r border-neutral-800 py-1 overflow-y-auto shrink-0">
            {categories.map((cat) => {
              const isActive = cat.toLowerCase() === activeCategory.toLowerCase();
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setActiveCategory(cat)}
                  onMouseEnter={() => setActiveCategory(cat)}
                  className={`flex items-center justify-between w-full px-3 py-1.5 text-xs text-left transition-colors ${
                    isActive
                      ? 'bg-neutral-800 text-white font-medium'
                      : 'text-neutral-300 hover:bg-neutral-800/50 hover:text-white'
                  }`}
                >
                  <span>{formatCategoryName(cat)}</span>
                  {isActive && <ChevronRight className="w-3.5 h-3.5 text-neutral-400" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Right column (padding p-3, grid grid-cols-3 gap-2): Format badges */}
        <div className="flex-1 p-3 overflow-y-auto">
          {displayedFormats.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-neutral-400 text-xs text-center py-8">
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
                    className={`px-3 py-1.5 text-xs font-mono font-semibold rounded text-center border transition-all ${
                      isSelected
                        ? 'bg-[#5C6BC0] border-[#5C6BC0] text-white shadow-md'
                        : 'bg-[#212529] hover:bg-neutral-700 text-white border-neutral-700/60'
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
