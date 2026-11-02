'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { FormatIcon } from './FormatIcon';

/** The conversions the home page links first; each `from`-`to` is a registered pair, held by tests/redesign-verification.test.ts. */
export const POPULAR_CONVERSIONS = [
  { key: 'pdfToWord', from: 'pdf', to: 'docx' },
  { key: 'wordToPdf', from: 'docx', to: 'pdf' },
  { key: 'jpgToPng', from: 'jpg', to: 'png' },
  { key: 'pngToJpg', from: 'png', to: 'jpg' },
  { key: 'heicToJpg', from: 'heic', to: 'jpg' },
  { key: 'imageToWebp', from: 'png', to: 'webp' },
  { key: 'videoToMp3', from: 'mp4', to: 'mp3' },
  { key: 'movToMp4', from: 'mov', to: 'mp4' },
  { key: 'epubToPdf', from: 'epub', to: 'pdf' },
  { key: 'excelToPdf', from: 'xlsx', to: 'pdf' },
] as const;

/** The popular conversions as a grid of cards under the hero: five columns on a desktop, three on a tablet, two on a phone. */
export default function PopularConversions() {
  const t = useTranslations('hero.popular');
  return (
    <nav aria-label={t('label')} className="mt-10 lg:mt-12">
      <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {POPULAR_CONVERSIONS.map((pair) => (
          <li key={pair.key} className="min-w-0">
            <Link
              href={`/${pair.from}-to-${pair.to}`}
              className="h-full min-h-[62px] px-3.5 py-3 flex items-center gap-2.5 rounded-md border border-rule bg-surface shadow-elev-1 text-sm font-extrabold text-ink hover:border-accent-edge transition-colors"
            >
              <span className="size-[30px] shrink-0 rounded-sm bg-accent-soft text-accent-ink flex items-center justify-center">
                <FormatIcon format={pair.from} className="size-4" />
              </span>
              <span className="min-w-0">{t(`pairs.${pair.key}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
