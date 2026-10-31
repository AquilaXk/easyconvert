import { REGISTRY_STATS } from '@/lib/registry-stats';

export type QueueSummaryInput = string | { sourceFormats: string[]; targetFormats: string[] };

export function resolveQueueSummary(summary?: QueueSummaryInput): string | undefined {
  if (!summary) return undefined;
  if (typeof summary === 'string') return summary;
  const srcs = summary.sourceFormats.map((s) => s.toUpperCase());
  const tgts = summary.targetFormats.filter(Boolean).map((t) => t.toUpperCase());
  if (srcs.length === 0) return undefined;
  return `Queued files (${srcs.join(', ')}${tgts.length > 0 ? ` to ${tgts.join(', ')}` : ''})`;
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

export function computeHeroTitle({
  categoryTitle,
  hasActiveQueue,
  activeSourceFormat,
  activeTargetFormat,
  sourceFormat,
  targetFormat,
  userChangedTiles,
}: HeroTitleState): string {
  if (categoryTitle && !userChangedTiles) return categoryTitle;
  const src = (hasActiveQueue ? activeSourceFormat || sourceFormat : sourceFormat).toLowerCase();
  const tgt = (hasActiveQueue ? activeTargetFormat || targetFormat : targetFormat).toLowerCase();
  const hasSrc = Boolean(src && src !== 'any');
  const hasTgt = Boolean(tgt && tgt !== 'any');
  if (hasSrc && hasTgt) return `${src.toUpperCase()} to ${tgt.toUpperCase()} Converter`;
  if (hasSrc) return `${src.toUpperCase()} Converter`;
  if (hasTgt) return `Convert to ${tgt.toUpperCase()}`;
  return 'File Converter';
}

export function computeHeroSubtitle(
  categoryDescription: string | undefined,
  hasActiveQueue: boolean,
  sourceFormat: string,
  targetFormat: string,
  userChangedTiles: boolean
): string {
  if (categoryDescription && !userChangedTiles && !hasActiveQueue) return categoryDescription;
  const countPhrase = `${REGISTRY_STATS.formatCount} formats in ${REGISTRY_STATS.categoryCount} categories`;
  if (hasActiveQueue) {
    return `Choose output formats, adjust parameters, and download converted files across ${countPhrase}.`;
  }
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  if (src && src !== 'any' && tgt && tgt !== 'any') {
    return `Convert ${src.toUpperCase()} to ${tgt.toUpperCase()} online. Supports ${countPhrase} with encrypted transfer and ephemeral processing.`;
  }
  if (src && src !== 'any') {
    return `Convert ${src.toUpperCase()} files online across ${countPhrase} with encrypted transfer and ephemeral processing.`;
  }
  return `Convert documents, images, audio, video, structured data, and archives online across ${countPhrase}.`;
}
