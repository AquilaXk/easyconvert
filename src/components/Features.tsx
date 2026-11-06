'use client';

import React, { useState } from 'react';
import { useFormatter, useTranslations, type Messages } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { FormatCategory } from '@/lib/types';
import { CategoryRegistryStat, REGISTRY_STATS } from '@/lib/registry-stats';
import { categoryIcon } from './workbench/FormatIcon';
import { RestApiWorkflowCard, SecurityDataHandlingCard } from './workbench/HomeEditorialSections';

/** A common pair of a category; its one-line summary is `features.pairs.<from>-<to>` in the messages. */
interface PopularPair {
  from: string;
  to: string;
}

type PairSummaryKey = `pairs.${keyof Messages['features']['pairs']}`;

export const POPULAR_PAIRS_BY_CATEGORY: Record<FormatCategory, ReadonlyArray<PopularPair>> = {
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
      <div>
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

        <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1">
          {REGISTRY_STATS.categories.map((cat) => {
            const isSelected = cat.id === activeCategory.id;
            const Icon = categoryIcon(cat.id);

            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectCategory(cat.id)}
                className={`inline-flex items-center gap-1.5 py-1 text-xs transition-colors cursor-pointer ${
                  isSelected ? 'text-accent-ink' : 'text-ink-3 hover:text-ink'
                }`}
              >
                <Icon aria-hidden="true" className="size-3" />
                <span className="font-medium">{tCategory(cat.id)}</span>
                <span className="font-mono text-[10px] text-ink-3">{cat.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 border-t border-rule pt-4 space-y-6">
        <div>
          <div className="mb-3 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider [:lang(ko)_&]:tracking-[0.05em] text-ink-3">
            <h3>{t('extensionsHeading', { category: activeLabel })}</h3>
            <span>{t('extensionsListed', { count: activeCategory.count })}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {activeCategory.formats.map((fmt) => (
              <Link
                key={fmt.id}
                href={`/${fmt.id}-converter`}
                className="bg-surface/60 px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-ink transition-colors hover:text-accent-ink"
              >
                {fmt.extension}
              </Link>
            ))}
          </div>
        </div>

        <div className="pt-5 border-t border-rule">
          <h3 className="mb-3 font-mono text-[11px] [:lang(ko)_&]:tracking-[0.05em] text-ink-3">
            {t('pairsHeading', { category: activeLabel })}
          </h3>
          <ul className="space-y-2">
            {popularPairs.map((pair) => (
              <li key={`${pair.from}-${pair.to}`}>
                <Link href={`/${pair.from}-to-${pair.to}`} className="block">
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase text-ink">
                    <span>{pair.from}</span>
                    <ArrowRight aria-hidden="true" className="size-3 text-ink-3" />
                    <span>{pair.to}</span>
                  </span>
                  <span className="block text-xs leading-[16.5px] text-ink-3">
                    {t(`pairs.${pair.from}-${pair.to}` as PairSummaryKey)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
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
