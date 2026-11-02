'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { getAvailableTargetFormats } from '@/lib/registry';
import FormatSelector from '../FormatSelector';
import { FormatIcon } from './FormatIcon';

interface HeroFormatTilesProps {
  sourceFormat: string;
  targetFormat: string;
  onSourceChange: (nextSource: string) => void;
  onTargetChange: (nextTarget: string) => void;
}

type Side = 'source' | 'target';

interface FormatTileProps {
  side: Side;
  format: string;
  display: string;
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

/** One tile of the pair: the format's icon over its name, a button that opens the format picker of its side. */
function FormatTile({ side, format, display, label, isOpen, onToggle, children }: Readonly<FormatTileProps>) {
  return (
    <div className="relative">
      <button
        type="button"
        data-testid={`hero-${side}-format-btn`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={label}
        onClick={onToggle}
        className="relative w-24 h-[104px] sm:w-28 sm:h-[120px] rounded-sm border border-rule bg-surface shadow-elev-1 hover:border-accent-edge text-ink flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer"
      >
        <FormatIcon format={format} className="size-6 text-ink-2" />
        <span className="text-sm font-bold uppercase">{display}</span>
        <ChevronDown
          aria-hidden="true"
          className={`absolute right-2 bottom-2 size-3.5 text-ink-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {children}
    </div>
  );
}

/** The pair of a converter page as two format tiles, each of which changes its side of the pair. */
export default function HeroFormatTiles({
  sourceFormat,
  targetFormat,
  onSourceChange,
  onTargetChange,
}: Readonly<HeroFormatTilesProps>) {
  const t = useTranslations('hero.tiles');
  const [openPicker, setOpenPicker] = useState<Side | null>(null);

  const normalizedSource = sourceFormat.toLowerCase();
  const normalizedTarget = targetFormat.toLowerCase();
  const isAnySource = normalizedSource === 'any' || !normalizedSource;
  const isAnyTarget = normalizedTarget === 'any' || !normalizedTarget;
  const sourceDisplay = isAnySource ? t('any') : normalizedSource.toUpperCase();
  const targetDisplay = isAnyTarget ? t('any') : normalizedTarget.toUpperCase();
  const toggle = (side: Side) => setOpenPicker((current) => (current === side ? null : side));

  return (
    <div className="inline-flex items-center justify-center gap-3 sm:gap-5">
      <FormatTile
        side="source"
        format={normalizedSource}
        display={sourceDisplay}
        label={t('sourceLabel', { format: sourceDisplay })}
        isOpen={openPicker === 'source'}
        onToggle={() => toggle('source')}
      >
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
      </FormatTile>

      <span className="text-xs uppercase tracking-widest text-ink-3 font-medium">{t('joiner')}</span>

      <FormatTile
        side="target"
        format={normalizedTarget}
        display={targetDisplay}
        label={t('targetLabel', { format: targetDisplay })}
        isOpen={openPicker === 'target'}
        onToggle={() => toggle('target')}
      >
        {openPicker === 'target' && (
          <FormatSelector
            allowAny
            availableFormats={isAnySource ? undefined : getAvailableTargetFormats(normalizedSource)}
            sourceFormat={isAnySource ? undefined : normalizedSource}
            selectedFormatId={normalizedTarget}
            onSelect={(fmt) => {
              onTargetChange(fmt);
              setOpenPicker(null);
            }}
            onClose={() => setOpenPicker(null)}
            title={t('toTitle')}
          />
        )}
      </FormatTile>
    </div>
  );
}
