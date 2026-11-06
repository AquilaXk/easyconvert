'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Files, Lock, UserRound } from 'lucide-react';
import { REGISTRY_STATS } from '@/lib/registry-stats';
import HeroFormatTiles from './workbench/HeroFormatTiles';
import HeroDropzoneCard from './workbench/HeroDropzoneCard';
import SourceChipPicker from './workbench/SourceChipPicker';
import { formatsSubtitle, formatsTitle } from './workbench/hero-copy';
import { useHeroUpload } from './hero/useHeroUpload';
import type { PairTiles } from './hero/usePairTiles';

type FilesSelected = (files: File[], target?: string) => void;

function HomeTrustRow() {
  const t = useTranslations('hero.trust');
  const items = [
    { Icon: Files, text: t('formats', { count: REGISTRY_STATS.formatCount }) },
    { Icon: Lock, text: t('encrypted') },
    { Icon: UserRound, text: t('noSignup') },
  ];
  return (
    <ul className="mt-6 flex flex-wrap justify-center lg:justify-start gap-x-[18px] gap-y-2 text-sm font-extrabold text-ink-2">
      {items.map(({ Icon, text }) => (
        <li key={text} className="inline-flex items-center gap-2">
          <Icon aria-hidden="true" className="size-4 text-ink-3 shrink-0" />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

interface HomeHeroProps {
  onFilesSelected: FilesSelected;
  /** The conversions a day the server allows an anonymous caller, read on the server. */
  dailyLimit: number;
}

/** The home page's hero: the title and trust row beside the upload card with the source chips. */
export function HomeHero({ onFilesSelected, dailyLimit }: Readonly<HomeHeroProps>) {
  const t = useTranslations('hero');
  const upload = useHeroUpload(onFilesSelected, undefined);
  return (
    <section className="pt-10 pb-16 lg:pt-14 lg:pb-20">
      <input {...upload.fileInput} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="lg:grid lg:grid-cols-2 lg:items-center lg:gap-14">
          <div className="text-center lg:text-left min-w-0">
            <h1 className="text-5xl sm:text-6xl lg:text-[78px] font-normal leading-[0.95] tracking-[-0.06em] text-ink">
              {t('title.default')}
            </h1>
            <p className="mt-6 text-lg sm:text-xl leading-normal text-ink-3 max-w-xl mx-auto lg:mx-0">{t('subtitle.default')}</p>
            <HomeTrustRow />
          </div>
          <div className="mt-10 lg:mt-0 min-w-0">
            <HeroDropzoneCard {...upload.dropzone} dailyLimit={dailyLimit}>
              <SourceChipPicker />
            </HeroDropzoneCard>
          </div>
        </div>
      </div>
    </section>
  );
}

interface PairHeroProps {
  onFilesSelected: FilesSelected;
  dailyLimit: number;
  /** The pair the tiles name, which the page holds so that it outlives the queue. */
  tiles: PairTiles;
  /** The page's own title and intro, shown until the tiles name another pair. */
  title: string;
  description: string;
}

/**
 * A converter page's hero: its title and intro beside the source and target tiles, and the upload card under them. Files
 * take the target the target tile shows, and none while it shows any format.
 */
export function PairHero({ onFilesSelected, dailyLimit, tiles, title, description }: Readonly<PairHeroProps>) {
  const t = useTranslations('hero');
  const { source, target, changed } = tiles;
  const upload = useHeroUpload(onFilesSelected, tiles.chosenTarget);

  return (
    <section className="pt-10 pb-16 lg:pt-14 lg:pb-20">
      <input {...upload.fileInput} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="lg:flex lg:items-center lg:justify-between lg:gap-12">
          <div className="text-center lg:text-left lg:max-w-2xl">
            <h1 className="text-4xl sm:text-5xl leading-none text-ink">{changed ? formatsTitle(t, source, target) : title}</h1>
            <p className="mt-5 text-lg leading-relaxed text-ink-2">
              {changed ? formatsSubtitle(t, source, target) : description}
            </p>
          </div>
          <div className="mt-8 lg:mt-0 flex justify-center shrink-0">
            <HeroFormatTiles
              sourceFormat={source}
              targetFormat={target}
              onSourceChange={tiles.changeSource}
              onTargetChange={tiles.changeTarget}
            />
          </div>
        </div>
        <div className="mt-10 lg:mt-12 max-w-2xl mx-auto">
          <HeroDropzoneCard {...upload.dropzone} dailyLimit={dailyLimit} />
        </div>
      </div>
    </section>
  );
}

interface QueueHeaderProps {
  onFilesSelected: FilesSelected;
  /** The formats the title names without a page title: those of the first file in the queue. */
  sourceFormat: string;
  /** The target files added over the queue take: the tiles' on a converter page, else the first file's. */
  targetFormat?: string;
  /** The title of a converter page, which stays while its queue is shown; the home page names the first file's formats. */
  pageTitle?: string;
  /** The intro of a converter page, which stays under its title; the home page has none. */
  pageDescription?: string;
}

/** The title over the file queue, and the file input and paste target that add more files to it. */
export function QueueHeader({
  onFilesSelected,
  sourceFormat,
  targetFormat,
  pageTitle,
  pageDescription,
}: Readonly<QueueHeaderProps>) {
  const t = useTranslations('hero');
  const upload = useHeroUpload(onFilesSelected, targetFormat || undefined);
  return (
    <section className="py-6 sm:py-8 border-b border-rule">
      <input {...upload.fileInput} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl sm:text-4xl leading-tight text-ink">{pageTitle ?? formatsTitle(t, sourceFormat, targetFormat)}</h1>
        {pageDescription && <p className="mt-1.5 text-sm text-ink-2 max-w-2xl">{pageDescription}</p>}
      </div>
    </section>
  );
}
