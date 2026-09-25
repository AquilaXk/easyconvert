'use client';

import React, { useState, useMemo } from 'react';
import { Search, Check, X, FileImage, FileText, Database, Archive } from 'lucide-react';
import { FormatDefinition, FormatCategory } from '@/lib/types';
import { getAllFormats } from '@/lib/registry';

interface FormatSelectorProps {
  availableFormats?: FormatDefinition[];
  selectedFormatId: string;
  onSelect: (formatId: string) => void;
  onClose: () => void;
  title?: string;
}

const CATEGORY_ICONS: Record<FormatCategory, React.ReactNode> = {
  image: <FileImage className="w-4 h-4" />,
  document: <FileText className="w-4 h-4" />,
  data: <Database className="w-4 h-4" />,
  archive: <Archive className="w-4 h-4" />,
  audio: <FileText className="w-4 h-4" />,
  video: <FileImage className="w-4 h-4" />,
  ebook: <FileText className="w-4 h-4" />,
};

export default function FormatSelector({
  availableFormats,
  selectedFormatId,
  onSelect,
  onClose,
  title = 'Select Target Format',
}: FormatSelectorProps) {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<string>('all');

  const formats = availableFormats || getAllFormats();

  const filteredFormats = useMemo(() => {
    return formats.filter((f) => {
      const matchesSearch =
        f.name.toLowerCase().includes(search.toLowerCase()) ||
        f.extension.toLowerCase().includes(search.toLowerCase()) ||
        f.description.toLowerCase().includes(search.toLowerCase());
      const matchesTab = activeTab === 'all' || f.category === activeTab;
      return matchesSearch && matchesTab;
    });
  }, [formats, search, activeTab]);

  const categories = useMemo(() => {
    const cats = new Set<string>();
    formats.forEach((f) => cats.add(f.category));
    return ['all', ...Array.from(cats)];
  }, [formats]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-950/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-white dark:bg-dark-surface rounded-2xl shadow-2xl border border-neutral-border dark:border-dark-border overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-neutral-border dark:border-dark-border flex items-center justify-between">
          <h3 className="text-lg font-bold text-brand-950 dark:text-dark-text">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-muted hover:text-brand-950 dark:hover:text-dark-text hover:bg-neutral-subtle dark:hover:bg-dark-elevated transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="p-4 border-b border-neutral-border dark:border-dark-border bg-neutral-scaffold/50 dark:bg-dark-scaffold/50">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search formats (e.g., pdf, webp, csv, json)..."
              autoFocus
              className="w-full pl-10 pr-4 py-2 text-sm bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500 text-brand-950 dark:text-dark-text placeholder:text-ink-muted"
            />
          </div>

          {/* Category Tabs */}
          <div className="flex gap-1.5 mt-3 overflow-x-auto pb-1 scrollbar-none">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveTab(cat)}
                className={`px-3 py-1 text-xs font-semibold rounded-lg capitalize whitespace-nowrap transition-colors ${
                  activeTab === cat
                    ? 'bg-brand-700 text-white shadow-sm'
                    : 'bg-white dark:bg-dark-surface text-ink-secondary dark:text-dark-muted hover:bg-brand-100 dark:hover:bg-dark-elevated'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Formats Grid */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {filteredFormats.length === 0 ? (
            <div className="py-12 text-center text-ink-muted">
              <p className="text-sm">No formats found matching &quot;{search}&quot;</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {filteredFormats.map((fmt) => {
                const isSelected = fmt.id.toLowerCase() === selectedFormatId.toLowerCase();
                return (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => {
                      onSelect(fmt.id);
                      onClose();
                    }}
                    className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/60 ring-1 ring-brand-600'
                        : 'border-neutral-border dark:border-dark-border hover:border-brand-300 dark:hover:border-brand-800 hover:bg-brand-50/50 dark:hover:bg-dark-elevated'
                    }`}
                  >
                    <div
                      className={`p-1.5 rounded-lg shrink-0 mt-0.5 ${
                        isSelected
                          ? 'bg-brand-700 text-white'
                          : 'bg-brand-100 dark:bg-brand-900/60 text-brand-700 dark:text-brand-300'
                      }`}
                    >
                      {CATEGORY_ICONS[fmt.category]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase text-brand-950 dark:text-dark-text truncate">
                          {fmt.name}
                        </span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400 shrink-0" />}
                      </div>
                      <p className="text-[11px] text-ink-muted capitalize truncate">{fmt.category}</p>
                    </div>
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
