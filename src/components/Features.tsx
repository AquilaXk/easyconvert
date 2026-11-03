'use client';

import React, { useState } from 'react';
import { useFormatter, useTranslations, type Messages } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { FormatCategory } from '@/lib/types';
import { CategoryRegistryStat, REGISTRY_STATS } from '@/lib/registry-stats';
import { RestApiWorkflowCard, SecurityDataHandlingCard } from './workbench/HomeEditorialSections';

/** A common pair of a category; its one-line summary is `features.pairs.<from>-<to>` in the messages. */
interface PopularPair {
  from: string;
  to: string;
}

type PairSummaryKey = `pairs.${keyof Messages['features']['pairs']}`;

const POPULAR_PAIRS_BY_CATEGORY: Record<FormatCategory, ReadonlyArray<PopularPair>> = {
  image: [
    { from: 'png', to: 'webp' },
    { from: 'heic', to: 'jpg' },
    { from: 'jpg', to: 'pdf' },
  ],
  document: [
    { from: 'pdf', to: 'docx' },
    { from: 'docx', to: 'pdf' },
    { from: 'hwp', to: 'pdf' },
  ],
  archive: [
    { from: 'rar', to: 'zip' },
    { from: '7z', to: 'zip' },
    { from: 'tar', to: 'zip' },
  ],
  video: [
    { from: 'mp4', to: 'mp3' },
    { from: 'mkv', to: 'mp4' },
    { from: 'mov', to: 'mp4' },
  ],
  audio: [
    { from: 'wav', to: 'mp3' },
    { from: 'flac', to: 'mp3' },
    { from: 'm4a', to: 'wav' },
  ],
  ebook: [
    { from: 'epub', to: 'pdf' },
    { from: 'mobi', to: 'epub' },
    { from: 'fb2', to: 'txt' },
  ],
  spreadsheet: [
    { from: 'xlsx', to: 'csv' },
    { from: 'xlsx', to: 'pdf' },
    { from: 'ods', to: 'xlsx' },
  ],
  presentation: [
    { from: 'pptx', to: 'pdf' },
    { from: 'pptx', to: 'html' },
    { from: 'odp', to: 'pptx' },
  ],
  data: [
    { from: 'csv', to: 'json' },
    { from: 'yaml', to: 'json' },
    { from: 'json', to: 'csv' },
  ],
  vector: [
    { from: 'svg', to: 'png' },
    { from: 'ai', to: 'pdf' },
    { from: 'eps', to: 'svg' },
  ],
  font: [
    { from: 'ttf', to: 'woff2' },
    { from: 'otf', to: 'ttf' },
    { from: 'woff', to: 'ttf' },
  ],
  cad: [
    { from: 'dwg', to: 'pdf' },
    { from: 'step', to: 'stl' },
    { from: 'dxf', to: 'svg' },
  ],
};

function FormatDirectoryCard({
  activeCategory,
  onSelectCategory,
}: Readonly<{
  activeCategory: CategoryRegistryStat;
  onSelectCategory: (id: FormatCategory) => void;
}>) {
  const t = useTranslations('features');
  const tCategory = useTranslations('formatCategories');
  const format = useFormatter();
  const popularPairs = POPULAR_PAIRS_BY_CATEGORY[activeCategory.id];
  const activeLabel = tCategory(activeCategory.id);

  return (
    <div className="border-t border-rule lg:col-span-8 min-w-0 pt-6 sm:pt-7">
      <div className="border-b border-rule pb-5">
        <h2 className="text-2xl sm:text-3xl text-ink">
          {t('directoryHeading')}
        </h2>
        <p className="mt-1.5 text-sm text-ink-2">
          {t('directoryIntro', {
            formats: REGISTRY_STATS.formatCount,
            categories: REGISTRY_STATS.categoryCount,
            pairs: format.number(REGISTRY_STATS.pairCount),
          })}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {REGISTRY_STATS.categories.map((cat) => {
            const isSelected = cat.id === activeCategory.id;
            const buttonStyle = isSelected
              ? 'bg-accent text-on-accent border-accent font-semibold'
              : 'text-ink-2 border-rule hover:border-accent hover:text-ink';
            const badgeStyle = isSelected
              ? 'bg-sunken text-ink'
              : 'bg-sunken text-ink-3';

            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectCategory(cat.id)}
                className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-sm border text-xs transition-colors cursor-pointer ${buttonStyle}`}
              >
                <span>{tCategory(cat.id)}</span>
                <span className={`px-1.5 py-0.5 rounded-md text-[11px] ${badgeStyle}`}>
                  {cat.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-5 space-y-6">
        <div>
          <h3 className="mb-3 text-sm font-bold text-ink">
            {t('extensionsHeading', { category: activeLabel, count: activeCategory.count })}
          </h3>
          <div className="flex flex-wrap gap-2">
            {activeCategory.formats.map((fmt) => (
              <Link
                key={fmt.id}
                href={`/${fmt.id}-converter`}
                className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-sm hover:bg-accent-soft border border-rule hover:border-accent text-xs font-semibold uppercase text-ink transition-colors"
              >
                {fmt.extension}
              </Link>
            ))}
          </div>
        </div>

        <div className="pt-5 border-t border-rule">
          <h3 className="text-sm font-bold text-ink mb-3">
            {t('pairsHeading', { category: activeLabel })}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {popularPairs.map((pair) => (
              <Link
                key={`${pair.from}-${pair.to}`}
                href={`/${pair.from}-to-${pair.to}`}
                className="group flex flex-col justify-between min-h-[44px] p-3.5 rounded-md border border-rule hover:border-accent transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase text-ink group-hover:text-accent-ink">
                    <span>{pair.from}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-ink-3" />
                    <span>{pair.to}</span>
                  </span>
                </div>
                <span className="mt-1.5 text-xs text-ink-2 leading-snug">
                  {t(`pairs.${pair.from}-${pair.to}` as PairSummaryKey)}
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

      <RestApiWorkflowCard />
    </div>
  );
}
