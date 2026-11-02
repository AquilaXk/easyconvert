import type { useTranslations } from 'next-intl';

export type HeroTranslator = ReturnType<typeof useTranslations<'hero'>>;

/** What the queue holds, for the badge beside the title of a page with more than one file queued. */
export interface QueueSummary {
  count: number;
  sourceFormats: string[];
  targetFormats: string[];
}

export function describeQueueSummary(t: HeroTranslator, summary?: QueueSummary): string | undefined {
  if (!summary || summary.count < 2 || summary.sourceFormats.length === 0) return undefined;
  const sources = summary.sourceFormats.map((s) => s.toUpperCase()).join(', ');
  const targets = summary.targetFormats.filter(Boolean).map((s) => s.toUpperCase()).join(', ');
  return targets
    ? t('queueSummaryWithTargets', { count: summary.count, sources, targets })
    : t('queueSummary', { count: summary.count, sources });
}

export interface HeroTitleState {
  categoryTitle?: string;
  hasActiveQueue: boolean;
  activeSourceFormat?: string;
  activeTargetFormat?: string;
  sourceFormat: string;
  targetFormat: string;
  userChangedTiles: boolean;
}

export function computeHeroTitle(
  t: HeroTranslator,
  {
    categoryTitle,
    hasActiveQueue,
    activeSourceFormat,
    activeTargetFormat,
    sourceFormat,
    targetFormat,
    userChangedTiles,
  }: HeroTitleState
): string {
  if (categoryTitle && !userChangedTiles) return categoryTitle;
  const src = (hasActiveQueue ? activeSourceFormat || sourceFormat : sourceFormat).toLowerCase();
  const tgt = (hasActiveQueue ? activeTargetFormat || targetFormat : targetFormat).toLowerCase();
  const hasSrc = Boolean(src && src !== 'any');
  const hasTgt = Boolean(tgt && tgt !== 'any');
  if (hasSrc && hasTgt) return t('title.pair', { src: src.toUpperCase(), tgt: tgt.toUpperCase() });
  if (hasSrc) return t('title.source', { src: src.toUpperCase() });
  if (hasTgt) return t('title.target', { tgt: tgt.toUpperCase() });
  return t('title.default');
}

export function computeHeroSubtitle(
  t: HeroTranslator,
  categoryDescription: string | undefined,
  hasActiveQueue: boolean,
  sourceFormat: string,
  targetFormat: string,
  userChangedTiles: boolean
): string {
  if (categoryDescription && !userChangedTiles && !hasActiveQueue) return categoryDescription;
  if (hasActiveQueue) return t('subtitle.queue');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  if (src && src !== 'any' && tgt && tgt !== 'any') {
    return t('subtitle.pair', { src: src.toUpperCase(), tgt: tgt.toUpperCase() });
  }
  if (src && src !== 'any') return t('subtitle.source', { src: src.toUpperCase() });
  return t('subtitle.default');
}
