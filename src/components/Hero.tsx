'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import HeroDropzoneCard from './workbench/HeroDropzoneCard';
import { formatsTitle } from './workbench/hero-copy';
import { useHeroUpload, type HeroOperation } from './hero/useHeroUpload';

type FilesSelected = (files: File[], target?: string) => void;

interface HomeHeroProps {
  onFilesSelected: FilesSelected;
  /** The conversions a day the server allows an anonymous caller, read on the server. */
  dailyLimit: number;
}

/**
 * The home page's hero: the title and intro centred over the upload card. It names no pair: the file chosen sets the source
 * and the target is picked after it.
 */
export function HomeHero({ onFilesSelected, dailyLimit }: Readonly<HomeHeroProps>) {
  const t = useTranslations('hero');
  const upload = useHeroUpload(onFilesSelected, undefined);
  return (
    <section className="pt-10 pb-6 lg:pt-14">
      <input {...upload.fileInput} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl text-ink">{t('title.default')}</h1>
          <p className="mt-5 text-base sm:text-lg sm:leading-relaxed text-ink-3">{t('subtitle.default')}</p>
        </div>
        <div className="mt-10 lg:mt-12 max-w-2xl mx-auto">
          <HeroDropzoneCard {...upload.dropzone} dailyLimit={dailyLimit} />
        </div>
      </div>
    </section>
  );
}

interface PairHeroProps {
  onFilesSelected: FilesSelected;
  dailyLimit: number;
  /** Target format of the converter page (`any` or omitted means chosen per file in the queue). */
  targetFormat?: string;
  /** The page's own title and optional intro (converter pages omit the intro; tool pages keep it). */
  title: string;
  description?: string;
  /** What the page does with the files when it does not convert them: merge, compress or recognise text. */
  operation?: HeroOperation;
}

/**
 * A converter or tool page's hero: its title and optional intro centred above the upload card without pair format tiles.
 */
export function PairHero({ onFilesSelected, dailyLimit, targetFormat, title, description, operation }: Readonly<PairHeroProps>) {
  const chosenTarget = targetFormat && targetFormat.toLowerCase() !== 'any' ? targetFormat.toLowerCase() : undefined;
  const upload = useHeroUpload(onFilesSelected, chosenTarget, operation);

  return (
    <section className="pt-10 pb-16 lg:pt-14 lg:pb-20">
      <input {...upload.fileInput} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl text-ink">{title}</h1>
          {description && <p className="mt-5 text-base sm:text-lg sm:leading-relaxed text-ink-3">{description}</p>}
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
  /** The target files added over the queue take: the converter page's target, else the first file's. */
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
