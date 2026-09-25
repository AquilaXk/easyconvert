'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Search, ChevronRight, X } from 'lucide-react';
import { FormatDefinition, FormatCategory } from '@/lib/types';
import { getAllFormats } from '@/lib/registry';

interface FormatSelectorProps {
  availableFormats?: FormatDefinition[];
  selectedFormatId?: string;
  onSelect: (formatId: string) => void;
  onClose: () => void;
  title?: string;
  anchorRef?: React.RefObject<HTMLElement>;
}

export default function FormatSelector({
  availableFormats,
  selectedFormatId,
  onSelect,
  onClose,
  title = 'Select Format',
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

  const categories = useMemo(() => {
    return Array.from(categoriesWithFormats.keys());
  }, [categoriesWithFormats]);

  // Determine initial active category based on selectedFormatId
  const initialCategory = useMemo(() => {
    if (selectedFormatId) {
      const found = allFormats.find((f) => f.id.toLowerCase() === selectedFormatId.toLowerCase());
      if (found && categories.includes(found.category)) {
        return found.category;
      }
    }
    return categories[0] || 'document';
  }, [selectedFormatId, allFormats, categories]);

  const [activeCategory, setActiveCategory] = useState<string>(initialCategory);

  // Close on Escape or click outside
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
    return cat.charAt(0).toUpperCase() + cat.slice(1);
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
      className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        ref={popoverRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-[440px] max-w-[95vw] bg-neutral-900 border border-neutral-700/80 rounded-xl shadow-2xl overflow-hidden flex flex-col text-white animate-in zoom-in-95 duration-150"
      >
        {/* Top: Search Format Input */}
        <div className="p-2.5 border-b border-neutral-800 flex items-center gap-2 bg-neutral-900/90">
          <Search className="w-4 h-4 text-neutral-400 shrink-0 ml-1" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Format"
            autoFocus
            className="w-full bg-transparent text-sm text-white placeholder-neutral-400 focus:outline-none py-1"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-neutral-400 hover:text-white p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors ml-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 2-Column Split: Categories on left, Formats grid on right */}
        <div className="flex h-72">
          {/* Left Column: Categories List */}
          {!search && (
            <div className="w-36 border-r border-neutral-800 py-2 overflow-y-auto shrink-0 select-none">
              {categories.map((cat) => {
                const isActive = cat === activeCategory;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setActiveCategory(cat)}
                    onMouseEnter={() => setActiveCategory(cat)}
                    className={`flex items-center justify-between w-full px-3 py-1.5 text-xs text-left transition-colors ${
                      isActive
                        ? 'bg-neutral-800 text-white font-semibold'
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

          {/* Right Column: Format Buttons Grid */}
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
                      className={`px-2 py-2 text-xs font-mono font-bold uppercase rounded-md text-center border transition-all ${
                        isSelected
                          ? 'bg-[#5C6BC0] border-[#5C6BC0] text-white shadow-md'
                          : 'bg-neutral-800/80 border-neutral-700/60 text-neutral-200 hover:border-[#5C6BC0] hover:bg-[#5C6BC0] hover:text-white'
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
    </div>
  );
}
