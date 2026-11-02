'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { getAvailableTargetFormats } from '@/lib/registry';

/**
 * The source formats the card offers first, in the order of the reference layout; a format without targets is left out. The
 * 20 fill a grid of five columns (four on a phone) without a short last row.
 */
const CHIP_SOURCES = [
  'pdf', 'docx', 'doc', 'jpg', 'png', 'webp', 'heic', 'mp4', 'mov', 'mp3',
  'wav', 'xlsx', 'csv', 'pptx', 'epub', 'svg', 'gif', 'flac', 'mkv', 'avi',
] as const;

/** The formats a source converts to, as the pair pages name them: every registered target but the source itself. */
function chipTargets(source: string): string[] {
  return getAvailableTargetFormats(source).map((format) => format.id).filter((id) => id !== source);
}

const SOURCES = CHIP_SOURCES.filter((source) => chipTargets(source).length > 0);

const CHIP_BASE =
  'min-h-[44px] inline-flex items-center justify-center rounded-sm border text-[13px] font-extrabold uppercase tracking-[0.02em] transition-colors';

/**
 * The format chips of the upload card: pick a source, and the chips swap in place to the targets of that source, each a link
 * to its pair page. The swap moves focus to "back", and "back" returns it to the chip it came from.
 */
export default function SourceChipPicker() {
  const t = useTranslations('hero.chips');
  const headingId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusTo = useRef<string | null>(null);

  useEffect(() => {
    if (chosen) {
      backRef.current?.focus();
    } else if (returnFocusTo.current) {
      chipRefs.current.get(returnFocusTo.current)?.focus();
      returnFocusTo.current = null;
    }
  }, [chosen]);

  const goBack = () => {
    returnFocusTo.current = chosen;
    setChosen(null);
  };

  if (chosen) {
    const label = chosen.toUpperCase();
    return (
      <div className="mt-8">
        <button
          ref={backRef}
          type="button"
          onClick={goBack}
          className="min-h-[44px] px-2 rounded-xs text-[13px] font-extrabold text-ink-3 hover:text-ink transition-colors cursor-pointer"
        >
          <span aria-hidden="true">← </span>
          {t('back')}
        </button>
        <div className="mt-1">
          <button
            type="button"
            aria-pressed="true"
            onClick={goBack}
            className={`${CHIP_BASE} px-4 border-accent bg-accent text-on-accent cursor-pointer`}
          >
            {label}
          </button>
        </div>
        <p id={headingId} className="mt-3 text-[22px] tracking-[-0.04em] text-ink">
          {t.rich('targets', { src: label, format: (chunks) => <span className="text-accent-ink">{chunks}</span> })}
        </p>
        <div role="group" aria-labelledby={headingId} className="mt-3 flex flex-wrap justify-center gap-2">
          {chipTargets(chosen).map((target) => (
            <Link
              key={target}
              href={`/${chosen}-to-${target}`}
              className={`${CHIP_BASE} px-4 border-accent-edge bg-accent-soft text-accent-ink hover:border-accent`}
            >
              {target.toUpperCase()}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <p id={headingId} className="text-sm font-semibold text-ink-2">
        {t('heading')}
      </p>
      <div role="group" aria-labelledby={headingId} className="mt-3 mx-auto max-w-md grid grid-cols-4 sm:grid-cols-5 gap-2">
        {SOURCES.map((source) => (
          <button
            key={source}
            ref={(node) => {
              if (node) chipRefs.current.set(source, node);
              else chipRefs.current.delete(source);
            }}
            type="button"
            aria-pressed="false"
            data-testid="source-chip"
            data-format={source}
            onClick={() => setChosen(source)}
            className={`${CHIP_BASE} px-1 border-rule bg-surface text-ink hover:border-accent cursor-pointer`}
          >
            {source.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
