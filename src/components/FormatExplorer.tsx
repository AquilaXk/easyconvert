'use client';

import React, { useState } from 'react';
import { ArrowRight, Sparkles, Layers } from 'lucide-react';
import { getAllFormats, CATEGORIES } from '@/lib/registry';
import { FormatCategory } from '@/lib/types';

interface FormatExplorerProps {
  onSelectPreset?: (source: string, target: string) => void;
}

export default function FormatExplorer({ onSelectPreset }: FormatExplorerProps) {
  const [activeCategory, setActiveCategory] = useState<FormatCategory>('image');
  const formats = getAllFormats().filter((f) => f.category === activeCategory);

  const popularPairs = [
    { from: 'PNG', to: 'PDF', src: 'png', tgt: 'pdf' },
    { from: 'WEBP', to: 'JPG', src: 'webp', tgt: 'jpg' },
    { from: 'JPG', to: 'PNG', src: 'jpg', tgt: 'png' },
    { from: 'Markdown', to: 'HTML', src: 'md', tgt: 'html' },
    { from: 'CSV', to: 'JSON', src: 'csv', tgt: 'json' },
    { from: 'JSON', to: 'CSV', src: 'json', tgt: 'csv' },
    { from: 'Markdown', to: 'PDF', src: 'md', tgt: 'pdf' },
    { from: 'Images', to: 'ZIP', src: 'png', tgt: 'zip' },
  ];

  return (
    <section id="format-directory" className="py-16 md:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      {/* Popular Conversions Bar */}
      <div className="mb-16">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-4 h-4 text-brand-700 dark:text-brand-400" />
          <h3 className="text-sm font-bold uppercase tracking-wider text-brand-950 dark:text-dark-text">
            Popular Conversions
          </h3>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {popularPairs.map((pair, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                onSelectPreset?.(pair.src, pair.tgt);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border hover:border-brand-500 dark:hover:border-brand-600 text-xs font-semibold text-brand-950 dark:text-dark-text shadow-sm hover:scale-102 transition-all"
            >
              <span>{pair.from}</span>
              <ArrowRight className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" />
              <span className="text-brand-700 dark:text-brand-400">{pair.to}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Categorized Matrix Directory */}
      <div className="bg-white dark:bg-dark-surface rounded-3xl border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h3 className="text-xl font-bold text-brand-950 dark:text-dark-text">Supported Format Directory</h3>
            <p className="text-xs text-ink-muted">Explore supported formats, descriptions, and conversion targets</p>
          </div>

          {/* Category buttons */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                  activeCategory === cat.id
                    ? 'bg-brand-700 text-white shadow-sm'
                    : 'bg-neutral-scaffold dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted hover:text-brand-700'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Formats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {formats.map((fmt) => (
            <div
              key={fmt.id}
              className="p-4 rounded-2xl border border-neutral-border dark:border-dark-border bg-neutral-scaffold/30 dark:bg-dark-elevated/30 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-bold text-brand-950 dark:text-dark-text">{fmt.name}</span>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-mono uppercase bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300">
                    .{fmt.extension}
                  </span>
                </div>
                <p className="text-xs text-ink-muted mb-4 line-clamp-2">{fmt.description}</p>
              </div>

              <div>
                <span className="text-[10px] font-semibold text-ink-muted uppercase block mb-1.5">
                  Converts to:
                </span>
                <div className="flex flex-wrap gap-1">
                  {fmt.targetFormats.slice(0, 6).map((tgt) => (
                    <span
                      key={tgt}
                      className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-dark-muted"
                    >
                      {tgt}
                    </span>
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
