'use client';

import React, { useState } from 'react';
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
  const [openPicker, setOpenPicker] = useState<'source' | 'target' | null>(null);

  const normalizedSource = sourceFormat.toLowerCase();
  const normalizedTarget = targetFormat.toLowerCase();
  const sourceDisplay =
    normalizedSource === 'any' || !normalizedSource ? 'ANY' : normalizedSource.toUpperCase();
  const targetDisplay =
    normalizedTarget === 'any' || !normalizedTarget ? '...' : normalizedTarget.toUpperCase();

  const targetAvailableFormats =
    normalizedSource !== 'any' && normalizedSource
      ? getAvailableTargetFormats(normalizedSource)
      : undefined;

  return (
    <div className="inline-flex items-center justify-center gap-2.5 sm:gap-3">
      <span className="hidden sm:inline text-xs uppercase tracking-wider text-slate-300 font-semibold">
        Convert
      </span>

      <div className="relative">
        <button
          type="button"
          data-testid="hero-source-format-btn"
          aria-haspopup="dialog"
          aria-expanded={openPicker === 'source'}
          aria-label={`Source format ${sourceDisplay}`}
          onClick={() => setOpenPicker((cur) => (cur === 'source' ? null : 'source'))}
          className="min-w-[104px] sm:min-w-[116px] min-h-[84px] sm:min-h-[96px] rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/15 px-4 py-3 text-white flex flex-col items-start justify-between transition-colors cursor-pointer"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
            FROM
          </span>
          <span className="w-full flex items-center justify-between gap-2 text-lg sm:text-xl font-mono font-bold uppercase">
            <span>{sourceDisplay}</span>
            <ChevronDown
              className={`w-4 h-4 text-slate-300 shrink-0 transition-transform duration-150 ${
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
            title="Convert from format"
          />
        )}
      </div>

      <span className="text-xs uppercase tracking-wider text-slate-300 font-semibold">to</span>

      <div className="relative">
        <button
          type="button"
          data-testid="hero-target-format-btn"
          aria-haspopup="dialog"
          aria-expanded={openPicker === 'target'}
          aria-label={`Target format ${targetDisplay === '...' ? 'any' : targetDisplay}`}
          onClick={() => setOpenPicker((cur) => (cur === 'target' ? null : 'target'))}
          className="min-w-[104px] sm:min-w-[116px] min-h-[84px] sm:min-h-[96px] rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/15 px-4 py-3 text-white flex flex-col items-start justify-between transition-colors cursor-pointer"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
            TO
          </span>
          <span className="w-full flex items-center justify-between gap-2 text-lg sm:text-xl font-mono font-bold uppercase">
            <span>{targetDisplay}</span>
            <ChevronDown
              className={`w-4 h-4 text-slate-300 shrink-0 transition-transform duration-150 ${
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
            title="Convert to format"
          />
        )}
      </div>
    </div>
  );
}
