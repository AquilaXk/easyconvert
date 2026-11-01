'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { getAvailableTargetFormats } from '@/lib/registry';
import FormatSelector from '../FormatSelector';

interface HeroFormatTilesProps {
  sourceFormat: string;
  targetFormat: string;
  onSourceChange: (nextSource: string) => void;
  onTargetChange: (nextTarget: string) => void;
}

export default function HeroFormatTiles({
  sourceFormat,
  targetFormat,
  onSourceChange,
  onTargetChange,
}: Readonly<HeroFormatTilesProps>) {
  const t = useTranslations('hero.tiles');
  const [openPicker, setOpenPicker] = useState<'source' | 'target' | null>(null);

  const normalizedSource = sourceFormat.toLowerCase();
  const normalizedTarget = targetFormat.toLowerCase();
  const isAnySource = normalizedSource === 'any' || !normalizedSource;
  const isAnyTarget = normalizedTarget === 'any' || !normalizedTarget;
  const sourceDisplay = isAnySource ? t('any') : normalizedSource.toUpperCase();
  const targetDisplay = isAnyTarget ? '...' : normalizedTarget.toUpperCase();

  const targetAvailableFormats =
    normalizedSource !== 'any' && normalizedSource
      ? getAvailableTargetFormats(normalizedSource)
      : undefined;

  return (
    <div className="inline-flex items-center justify-center gap-2.5 sm:gap-3">
      <span className="hidden sm:inline text-xs uppercase tracking-widest text-ink-3 font-medium">
        {t('convert')}
      </span>

      <div className="relative">
        <button
          type="button"
          data-testid="hero-source-format-btn"
          aria-haspopup="dialog"
          aria-expanded={openPicker === 'source'}
          aria-label={t('sourceLabel', { format: sourceDisplay })}
          onClick={() => setOpenPicker((cur) => (cur === 'source' ? null : 'source'))}
          className="transition-colors min-w-[116px] sm:min-w-[132px] min-h-[84px] rounded-xs border-t border-rule-strong hover:border-accent px-1 pt-2.5 pb-1 text-ink flex flex-col items-start justify-between cursor-pointer"
        >
          <span className="text-xs font-medium uppercase tracking-widest text-ink-3">
            {t('from')}
          </span>
          <span className="w-full flex items-center justify-between gap-2 font-display text-3xl uppercase">
            <span>{sourceDisplay}</span>
            <ChevronDown
              className={`w-4 h-4 text-ink-3 shrink-0 transition-transform duration-300 ease-spring ${
                openPicker === 'source' ? 'rotate-180' : ''
              }`}
            />
          </span>
        </button>

        {openPicker === 'source' && (
          <FormatSelector
            allowAny
            selectedFormatId={normalizedSource}
            onSelect={(fmt) => {
              onSourceChange(fmt);
              setOpenPicker(null);
            }}
            onClose={() => setOpenPicker(null)}
            title={t('fromTitle')}
          />
        )}
      </div>

      <span className="text-xs uppercase tracking-widest text-ink-3 font-medium">{t('joiner')}</span>

      <div className="relative">
        <button
          type="button"
          data-testid="hero-target-format-btn"
          aria-haspopup="dialog"
          aria-expanded={openPicker === 'target'}
          aria-label={t('targetLabel', { format: isAnyTarget ? t('anyFormat') : targetDisplay })}
          onClick={() => setOpenPicker((cur) => (cur === 'target' ? null : 'target'))}
          className="transition-colors min-w-[116px] sm:min-w-[132px] min-h-[84px] rounded-xs border-t border-rule-strong hover:border-accent px-1 pt-2.5 pb-1 text-ink flex flex-col items-start justify-between cursor-pointer"
        >
          <span className="text-xs font-medium uppercase tracking-widest text-ink-3">
            {t('to')}
          </span>
          <span className="w-full flex items-center justify-between gap-2 font-display text-3xl uppercase">
            <span>{targetDisplay}</span>
            <ChevronDown
              className={`w-4 h-4 text-ink-3 shrink-0 transition-transform duration-300 ease-spring ${
                openPicker === 'target' ? 'rotate-180' : ''
              }`}
            />
          </span>
        </button>

        {openPicker === 'target' && (
          <FormatSelector
            allowAny
            availableFormats={targetAvailableFormats}
            sourceFormat={normalizedSource !== 'any' ? normalizedSource : undefined}
            selectedFormatId={normalizedTarget}
            onSelect={(fmt) => {
              onTargetChange(fmt);
              setOpenPicker(null);
            }}
            onClose={() => setOpenPicker(null)}
            title={t('toTitle')}
          />
        )}
      </div>
    </div>
  );
}
