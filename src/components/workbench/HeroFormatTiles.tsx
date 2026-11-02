'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { getAvailableTargetFormats } from '@/lib/registry';
import FormatPickerButton from './FormatPickerButton';
import { FormatIcon } from './FormatIcon';

interface HeroFormatTilesProps {
  sourceFormat: string;
  targetFormat: string;
  onSourceChange: (nextSource: string) => void;
  onTargetChange: (nextTarget: string) => void;
}

const TILE_CLASS =
  'group relative w-24 h-[104px] sm:w-28 sm:h-[120px] rounded-sm border border-rule bg-surface shadow-elev-1 hover:border-accent-edge text-ink flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer';

/** What a tile shows: the format's icon over its name, and a chevron that turns while its picker is open. */
function TileFace({ format, display }: Readonly<{ format: string; display: string }>) {
  return (
    <>
      <FormatIcon format={format} className="size-6 text-ink-2" />
      <span className="text-sm font-bold uppercase">{display}</span>
      <ChevronDown
        aria-hidden="true"
        className="absolute right-2 bottom-2 size-3.5 text-ink-3 transition-transform duration-200 group-aria-expanded:rotate-180"
      />
    </>
  );
}

/** The pair of a converter page as two format tiles, each a button that opens the format picker of its side. */
export default function HeroFormatTiles({
  sourceFormat,
  targetFormat,
  onSourceChange,
  onTargetChange,
}: Readonly<HeroFormatTilesProps>) {
  const t = useTranslations('hero.tiles');

  const normalizedSource = sourceFormat.toLowerCase();
  const normalizedTarget = targetFormat.toLowerCase();
  const isAnySource = normalizedSource === 'any' || !normalizedSource;
  const isAnyTarget = normalizedTarget === 'any' || !normalizedTarget;
  const sourceDisplay = isAnySource ? t('any') : normalizedSource.toUpperCase();
  const targetDisplay = isAnyTarget ? t('any') : normalizedTarget.toUpperCase();

  return (
    <div className="inline-flex items-center justify-center gap-3 sm:gap-5">
      <FormatPickerButton
        testId="hero-source-format-btn"
        ariaLabel={t('sourceLabel', { format: sourceDisplay })}
        className={TILE_CLASS}
        selectedFormatId={normalizedSource}
        onSelect={onSourceChange}
        title={t('fromTitle')}
      >
        <TileFace format={normalizedSource} display={sourceDisplay} />
      </FormatPickerButton>

      <span className="text-xs uppercase tracking-widest text-ink-3 font-medium">{t('joiner')}</span>

      <FormatPickerButton
        testId="hero-target-format-btn"
        ariaLabel={t('targetLabel', { format: targetDisplay })}
        className={TILE_CLASS}
        availableFormats={isAnySource ? undefined : getAvailableTargetFormats(normalizedSource)}
        sourceFormat={isAnySource ? undefined : normalizedSource}
        selectedFormatId={normalizedTarget}
        onSelect={onTargetChange}
        title={t('toTitle')}
      >
        <TileFace format={normalizedTarget} display={targetDisplay} />
      </FormatPickerButton>
    </div>
  );
}
