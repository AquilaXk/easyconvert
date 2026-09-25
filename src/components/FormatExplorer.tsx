'use client';

import React, { useState, useMemo } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { getAllFormats, CATEGORIES } from '@/lib/registry';
import { FormatCategory } from '@/lib/types';

interface FormatExplorerProps {
  onSelectPreset?: (source: string, target: string) => void;
}

export default function FormatExplorer({ onSelectPreset }: FormatExplorerProps) {
  const [activeCategory, setActiveCategory] = useState<FormatCategory | 'all'>('audio');
  const [search, setSearch] = useState('');

  const allFormats = getAllFormats();

  const filteredFormats = useMemo(() => {
    return allFormats.filter((fmt) => {
      const matchesCategory = activeCategory === 'all' || fmt.category === activeCategory;
      const q = search.toLowerCase();
      const matchesSearch =
        !search ||
        fmt.name.toLowerCase().includes(q) ||
        fmt.extension.toLowerCase().includes(q) ||
        fmt.description.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [allFormats, activeCategory, search]);

  const popularPairs = [
    { from: 'PDF', to: 'Word (DOCX)', src: 'pdf', tgt: 'docx' },
    { from: 'MP4', to: 'MP3 Audio', src: 'mp4', tgt: 'mp3' },
    { from: 'DOCX', to: 'PDF', src: 'docx', tgt: 'pdf' },
    { from: 'PNG', to: 'WebP', src: 'png', tgt: 'webp' },
    { from: 'XLSX', to: 'CSV Data', src: 'xlsx', tgt: 'csv' },
    { from: 'EPUB', to: 'PDF Book', src: 'epub', tgt: 'pdf' },
    { from: 'WAV', to: 'MP3', src: 'wav', tgt: 'mp3' },
    { from: 'WEBM', to: 'MP4 Video', src: 'webm', tgt: 'mp4' },
    { from: 'CSV', to: 'JSON', src: 'csv', tgt: 'json' },
    { from: 'Images', to: 'ZIP Archive', src: 'png', tgt: 'zip' },
  ];

  return (
    <section id="format-directory" className="py-14 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      {/* Popular Conversions */}
      <div className="mb-12">
        <h3 className="text-xs font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text mb-3">
          Popular Conversion Presets
        </h3>
        <div className="flex flex-wrap gap-2">
          {popularPairs.map((pair, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                onSelectPreset?.(pair.src, pair.tgt);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border hover:border-brand-500 text-xs font-semibold text-brand-950 dark:text-dark-text shadow-sm transition-all"
            >
              <span>{pair.from}</span>
              <ArrowRight className="w-3 h-3 text-brand-700 dark:text-brand-400" />
              <span className="text-brand-700 dark:text-brand-400">{pair.to}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Categorized Matrix Directory */}
      <div className="bg-white dark:bg-dark-surface rounded-2xl border border-neutral-border dark:border-dark-border p-5 sm:p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="text-base font-bold text-brand-950 dark:text-dark-text">
              Universal Format Registry ({allFormats.length} Formats across 9 Domains)
            </h3>
            <p className="text-xs text-ink-muted">
              Complete matrix of supported codecs, containers, documents, spreadsheets, and archives.
            </p>
          </div>

          {/* Search Box */}
          <div className="relative w-full md:w-64">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search formats..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border rounded-lg text-brand-950 dark:text-dark-text focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </div>
        </div>

        {/* Category Tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-2 mb-6 scrollbar-none">
          <button
            type="button"
            onClick={() => setActiveCategory('all')}
            className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
              activeCategory === 'all'
                ? 'bg-brand-700 text-white shadow-sm'
                : 'bg-neutral-scaffold dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted hover:text-brand-700'
            }`}
          >
            All Formats ({allFormats.length})
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCategory(cat.id)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
                activeCategory === cat.id
                  ? 'bg-brand-700 text-white shadow-sm'
                  : 'bg-neutral-scaffold dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted hover:text-brand-700'
              }`}
            >
              {cat.label} ({cat.count})
            </button>
          ))}
        </div>

        {/* Formats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredFormats.map((fmt) => (
            <div
              key={fmt.id}
              className="p-3.5 rounded-xl border border-neutral-border dark:border-dark-border bg-neutral-scaffold/40 dark:bg-dark-elevated/40 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-brand-950 dark:text-dark-text truncate">
                    {fmt.name}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300 font-bold shrink-0">
                    .{fmt.extension}
                  </span>
                </div>
                <p className="text-[11px] text-ink-muted mb-3 line-clamp-2 leading-relaxed">
                  {fmt.description}
                </p>
              </div>

              <div>
                <span className="text-[10px] font-semibold text-ink-muted uppercase block mb-1">
                  Converts to:
                </span>
                <div className="flex flex-wrap gap-1">
                  {fmt.targetFormats.slice(0, 6).map((tgt) => (
                    <button
                      key={tgt}
                      type="button"
                      onClick={() => {
                        onSelectPreset?.(fmt.extension, tgt);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-dark-muted hover:border-brand-500 hover:text-brand-700 transition-colors"
                    >
                      {tgt}
                    </button>
                  ))}
                  {fmt.targetFormats.length > 6 && (
                    <span className="text-[10px] text-ink-muted pl-1">
                      +{fmt.targetFormats.length - 6} more
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
