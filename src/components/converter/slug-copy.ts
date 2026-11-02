import type { Messages, useTranslations } from 'next-intl';
import type { SlugCopy, SlugName } from '@/lib/slug-parser';

export type SlugCopyTranslator = ReturnType<typeof useTranslations<'slugPages'>>;

export interface LocalizedSlugCopy {
  title: string;
  description: string;
}

type NameKey = `names.${keyof Messages['slugPages']['names']}`;

/** A word of a title (Video, Word, Spreadsheet) in the page's language; a format name reads as the English copy names it. */
function nameOf(t: SlugCopyTranslator, name: SlugName): string {
  const key = `names.${name.display}` as NameKey;
  return t.has(key) ? t(key) : name.display;
}

/** The title and description of a slug page in the page's language, from the slug's copy descriptor. */
export function localizeSlugCopy(t: SlugCopyTranslator, copy: SlugCopy): LocalizedSlugCopy {
  switch (copy.kind) {
    case 'info':
      return { title: t(`info.${copy.page}.title`), description: t(`info.${copy.page}.description`) };
    case 'ocr':
      return { title: t('ocr.title'), description: t('ocr.description') };
    case 'unitPair':
      return {
        title: t('unitPair.title', { src: copy.src.toUpperCase(), tgt: copy.tgt.toUpperCase() }),
        description: t('unitPair.description', {
          src: t(`units.${copy.src as 'lbs'}`),
          tgt: t(`units.${copy.tgt as 'lbs'}`),
        }),
      };
    case 'pair': {
      const names = { src: nameOf(t, copy.src), tgt: nameOf(t, copy.tgt) };
      return { title: t('pair.title', names), description: t(`pair.description.${copy.group}`, names) };
    }
    case 'format': {
      const name = nameOf(t, copy.name);
      return { title: t('format.title', { name }), description: t(`format.description.${copy.group}`, { name }) };
    }
    case 'merge':
      return { title: t('merge.title', { format: copy.format.toUpperCase() }), description: t('merge.description', { format: copy.format.toUpperCase() }) };
    case 'compress':
      return { title: t('compress.title', { format: copy.format.toUpperCase() }), description: t('compress.description', { format: copy.format.toUpperCase() }) };
    case 'saveWebsiteAsPdf':
      return { title: t('saveWebsiteAsPdf.title'), description: t('saveWebsiteAsPdf.description') };
    case 'websiteScreenshot':
      return {
        title: t('websiteScreenshot.title', { format: copy.format.toUpperCase() }),
        description: t('websiteScreenshot.description', { format: copy.format.toUpperCase() }),
      };
    case 'generic':
      return { title: t('generic.title', { name: copy.name }), description: t('generic.description', { name: copy.name }) };
  }
}
