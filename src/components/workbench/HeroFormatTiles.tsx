'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, RefreshCw } from 'lucide-react';
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

/** The connector between the tiles: a circle with the swap icon between two lines that fade from the rule colour to the accent, and the joining word under it (read aloud in Korean, where the circle alone shows it). */
function TileConnector({ joiner }: Readonly<{ joiner: string }>) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div aria-hidden="true" className="flex items-center">
        <span className="h-px w-5 sm:w-7 bg-gradient-to-r from-rule to-accent/70" />
        <span className="mx-1 flex size-10 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-accent-ink">
          <RefreshCw className="size-4" />
        </span>
        <span className="h-px w-5 sm:w-7 bg-gradient-to-l from-rule to-accent/70" />
      </div>
      <span className="text-[10.4px] font-medium uppercase tracking-[0.25em] text-ink-3 [:lang(ko)_&]:sr-only">{joiner}</span>
    </div>
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
    <div className="inline-flex items-center justify-center gap-[17px]">
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

      <TileConnector joiner={t('joiner')} />

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
