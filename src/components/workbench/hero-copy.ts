import type { useTranslations } from 'next-intl';

export type HeroTranslator = ReturnType<typeof useTranslations<'hero'>>;

const named = (format: string | undefined): format is string => Boolean(format && format.toLowerCase() !== 'any');

/** A title naming the chosen formats: "PNG to JPG Converter", "PNG Converter", "Convert to JPG", or the default. */
export function formatsTitle(t: HeroTranslator, source?: string, target?: string): string {
  if (named(source) && named(target)) return t('title.pair', { src: source.toUpperCase(), tgt: target.toUpperCase() });
  if (named(source)) return t('title.source', { src: source.toUpperCase() });
  if (named(target)) return t('title.target', { tgt: target.toUpperCase() });
  return t('title.default');
}
