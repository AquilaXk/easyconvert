'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { FormatCategory } from '@/lib/types';
import { CategoryRegistryStat, REGISTRY_STATS } from '@/lib/registry-stats';
import {
  HowConversionWorksCard,
  RestApiWorkflowCard,
  SecurityDataHandlingCard,
} from './workbench/HomeEditorialSections';

interface PopularPair {
  from: string;
  to: string;
  summary: string;
}

const POPULAR_PAIRS_BY_CATEGORY: Record<FormatCategory, ReadonlyArray<PopularPair>> = {
  image: [
    { from: 'png', to: 'webp', summary: 'Web image compression with alpha support' },
    { from: 'heic', to: 'jpg', summary: 'Camera photo compatibility across devices' },
    { from: 'jpg', to: 'pdf', summary: 'Printable single-page document export' },
  ],
  document: [
    { from: 'pdf', to: 'docx', summary: 'Editable Word document output' },
    { from: 'docx', to: 'pdf', summary: 'Fixed-layout PDF distribution' },
    { from: 'hwp', to: 'pdf', summary: 'Hangul office document rendering' },
  ],
  archive: [
    { from: 'rar', to: 'zip', summary: 'Standard ZIP archive repackaging' },
    { from: '7z', to: 'zip', summary: 'Cross-platform archive compatibility' },
    { from: 'tar', to: 'zip', summary: 'Compressed bundle conversion' },
  ],
  video: [
    { from: 'mp4', to: 'mp3', summary: 'Audio track extraction from video' },
    { from: 'mkv', to: 'mp4', summary: 'Browser and mobile playback container' },
    { from: 'mov', to: 'mp4', summary: 'Standard H.264 MP4 container export' },
  ],
  audio: [
    { from: 'wav', to: 'mp3', summary: 'Compact MP3 audio encoding' },
    { from: 'flac', to: 'mp3', summary: 'Lossless source to portable MP3' },
    { from: 'm4a', to: 'wav', summary: 'Uncompressed PCM waveform output' },
  ],
  ebook: [
    { from: 'epub', to: 'pdf', summary: 'Paginated PDF layout from e-book' },
    { from: 'mobi', to: 'epub', summary: 'Open EPUB e-reader format' },
    { from: 'fb2', to: 'txt', summary: 'Plain UTF-8 text extraction' },
  ],
  spreadsheet: [
    { from: 'xlsx', to: 'csv', summary: 'Delimited plain-text table export' },
    { from: 'xlsx', to: 'pdf', summary: 'Formatted spreadsheet printout' },
    { from: 'ods', to: 'xlsx', summary: 'Excel workbook compatibility' },
  ],
  presentation: [
    { from: 'pptx', to: 'pdf', summary: 'Portable slide deck handout' },
    { from: 'pptx', to: 'html', summary: 'Browser-viewable slide markup' },
    { from: 'odp', to: 'pptx', summary: 'PowerPoint slide deck export' },
  ],
  data: [
    { from: 'csv', to: 'json', summary: 'Structured JSON record array' },
    { from: 'yaml', to: 'json', summary: 'Configuration file normalization' },
    { from: 'json', to: 'csv', summary: 'Tabular row and column export' },
  ],
  vector: [
    { from: 'svg', to: 'png', summary: 'Crisp rasterized PNG graphic' },
    { from: 'ai', to: 'pdf', summary: 'Vector artwork preservation in PDF' },
    { from: 'eps', to: 'svg', summary: 'Web-ready scalable SVG vector' },
  ],
  font: [
    { from: 'ttf', to: 'woff2', summary: 'Compressed WOFF2 web font' },
    { from: 'otf', to: 'ttf', summary: 'TrueType desktop font binary' },
    { from: 'woff', to: 'ttf', summary: 'Installable TrueType font output' },
  ],
  cad: [
    { from: 'dwg', to: 'pdf', summary: 'Technical drawing PDF sheet' },
    { from: 'step', to: 'stl', summary: 'Triangle mesh for 3D printing' },
    { from: 'dxf', to: 'svg', summary: '2D vector CAD plot export' },
  ],
};

function FormatDirectoryCard({
  activeCategory,
  onSelectCategory,
}: Readonly<{
  activeCategory: CategoryRegistryStat;
  onSelectCategory: (id: FormatCategory) => void;
}>) {
  const popularPairs = POPULAR_PAIRS_BY_CATEGORY[activeCategory.id];

  return (
    <div className="lg:col-span-8 min-w-0 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface p-6 sm:p-7">
      <div className="border-b border-neutral-border dark:border-dark-border pb-5">
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-brand-950 dark:text-white">
          Supported Format Directory
        </h2>
        <p className="mt-1.5 text-sm text-ink-secondary dark:text-neutral-300">
          Browse {REGISTRY_STATS.formatCount} formats across {REGISTRY_STATS.categoryCount} categories
          covering {REGISTRY_STATS.pairCount.toLocaleString('en-US')} registered conversion pairs.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {REGISTRY_STATS.categories.map((cat) => {
            const isSelected = cat.id === activeCategory.id;
            const buttonStyle = isSelected
              ? 'bg-brand-700 text-white border-brand-700 font-semibold'
              : 'bg-neutral-scaffold dark:bg-dark-scaffold text-ink-secondary dark:text-neutral-300 border-neutral-border dark:border-dark-border hover:border-brand-700 hover:text-brand-950 dark:hover:text-white';
            const badgeStyle = isSelected
              ? 'bg-white/20 text-white'
              : 'bg-white dark:bg-dark-surface text-ink-muted dark:text-neutral-400';

            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectCategory(cat.id)}
                className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-md border text-xs transition-colors cursor-pointer ${buttonStyle}`}
              >
                <span>{cat.label}</span>
                <span className={`px-1.5 py-0.5 rounded font-mono text-[11px] ${badgeStyle}`}>
                  {cat.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-5 space-y-6">
        <div>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-brand-950 dark:text-white">
              {activeCategory.label} Extensions ({activeCategory.count})
            </h3>
            <span className="text-xs text-ink-muted dark:text-neutral-400">
              Select an extension to open its converter
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeCategory.formats.map((fmt) => (
              <Link
                key={fmt.id}
                href={`/${fmt.id}-converter`}
                className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-md bg-neutral-scaffold dark:bg-dark-scaffold hover:bg-brand-50 dark:hover:bg-dark-elevated border border-neutral-border dark:border-dark-border hover:border-brand-700 dark:hover:border-brand-400 font-mono text-xs font-semibold uppercase text-brand-950 dark:text-neutral-200 transition-colors"
              >
                {fmt.extension}
              </Link>
            ))}
          </div>
        </div>

        <div className="pt-5 border-t border-neutral-border dark:border-dark-border">
          <h3 className="text-sm font-bold text-brand-950 dark:text-white mb-3">
            Common {activeCategory.label} Pairs
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {popularPairs.map((pair) => (
              <Link
                key={`${pair.from}-${pair.to}`}
                href={`/${pair.from}-to-${pair.to}`}
                className="group flex flex-col justify-between min-h-[44px] p-3.5 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border hover:border-brand-700 dark:hover:border-brand-400 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold uppercase text-brand-950 dark:text-white group-hover:text-brand-700 dark:group-hover:text-brand-300">
                    <span>{pair.from}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-ink-muted" />
                    <span>{pair.to}</span>
                  </span>
                </div>
                <span className="mt-1.5 text-xs text-ink-secondary dark:text-neutral-400 leading-snug">
                  {pair.summary}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Features() {
  const [selectedCategory, setSelectedCategory] = useState<FormatCategory>('document');

  const activeCategory =
    REGISTRY_STATS.categories.find((cat) => cat.id === selectedCategory) ||
    REGISTRY_STATS.categories[0];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 space-y-12">
      <section
        id="format-catalog"
        className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
      >
        <FormatDirectoryCard
          activeCategory={activeCategory}
          onSelectCategory={setSelectedCategory}
        />
        <SecurityDataHandlingCard />
      </section>

      <section
        id="how-it-works"
        className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
      >
        <RestApiWorkflowCard />
        <HowConversionWorksCard />
      </section>
    </div>
  );
}
