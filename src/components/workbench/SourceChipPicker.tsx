'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/**
 * The source formats the card offers, in the order of the reference layout, each with the targets people convert it to
 * most, as that layout lists them: at most ten, each format once by its own name, and only targets the registry has
 * (tests/home-source-chips.test.ts holds both). "See all formats" leads to the format page for the rest.
 */
export const COMMON_TARGETS: Readonly<Record<string, readonly string[]>> = {
  pdf: ['docx', 'txt', 'html', 'jpg', 'png', 'rtf', 'epub', 'pptx', 'xlsx'],
  docx: ['pdf', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub'],
  doc: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html'],
  jpg: ['png', 'webp', 'gif', 'bmp', 'tiff', 'avif', 'ico', 'svg', 'pdf'],
  png: ['jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif', 'ico', 'svg', 'pdf'],
  webp: ['jpg', 'png', 'gif', 'bmp', 'tiff', 'avif'],
  heic: ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'pdf'],
  mp4: ['avi', 'mkv', 'mov', 'webm', 'wmv', 'flv', 'gif', 'mp3', 'wav'],
  mov: ['mp4', 'avi', 'mkv', 'webm', 'wmv', 'gif'],
  mp3: ['wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'aiff'],
  wav: ['mp3', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'aiff'],
  xlsx: ['pdf', 'xls', 'ods', 'csv'],
  csv: ['xlsx', 'xls', 'ods', 'pdf'],
  pptx: ['pdf', 'ppt', 'odp', 'png', 'jpg'],
  epub: ['pdf', 'txt', 'html', 'docx'],
  svg: ['png', 'jpg', 'pdf'],
  gif: ['jpg', 'png', 'webp', 'bmp', 'mp4'],
  flac: ['mp3', 'wav', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'aiff'],
  mkv: ['mp4', 'avi', 'mov', 'webm', 'wmv', 'flv'],
  avi: ['mp4', 'mkv', 'mov', 'webm', 'wmv', 'flv', 'gif'],
};

const SOURCES = Object.keys(COMMON_TARGETS);

const CHIP_BASE =
  'min-h-[44px] inline-flex items-center justify-center rounded-sm border text-[13px] font-extrabold uppercase tracking-[0.02em] transition-colors';

/**
 * The format chips of the upload card: pick a source, and the chips swap in place to the common targets of that source, each
 * a link to its pair page, then a link to its format page. The swap moves focus to "back", and "back" returns it to the chip
 * it came from.
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
            aria-label={t('change', { format: label })}
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
          {COMMON_TARGETS[chosen].map((target) => (
            <Link
              key={target}
              href={`/${chosen}-to-${target}`}
              className={`${CHIP_BASE} px-4 border-accent-edge bg-accent-soft text-accent-ink hover:border-accent`}
            >
              {target.toUpperCase()}
            </Link>
          ))}
          <Link
            href={`/${chosen}-converter`}
            className="min-h-[44px] inline-flex items-center px-2 text-[13px] font-extrabold text-accent-ink hover:underline"
          >
            {t('allFormats')}
          </Link>
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
            aria-label={t('pick', { format: source.toUpperCase() })}
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
