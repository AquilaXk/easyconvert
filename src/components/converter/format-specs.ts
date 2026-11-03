import { useTranslations } from 'next-intl';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { formatMessageKey } from '@/i18n/message-keys';
import type { FormatCategory } from '@/lib/types';
import { MEDIA_FORMAT_SPECIFICATIONS } from './format-specs-media';
import { PACKAGE_FORMAT_SPECIFICATIONS } from './format-specs-packages';

/** The fact of a format that reads the same in every language: its full name. */
export interface FormatFacts {
  fullName: string;
}

/** A format's card as the page shows it, its description in the page's language. */
export interface FormatSpecification extends FormatFacts {
  desc: string;
}

/** The formats with a written description; it is `formatSpecs.<id>.desc` in the messages. */
export const FORMAT_SPECIFICATIONS: Record<string, FormatFacts> = {
  pdf: {
    fullName: 'Portable Document Format',
  },
  docx: {
    fullName: 'Office Open XML Document',
  },
  doc: {
    fullName: 'Microsoft Word 97-2003 Binary Document',
  },
  csv: {
    fullName: 'Comma-Separated Values',
  },
  json: {
    fullName: 'JavaScript Object Notation',
  },
  xlsx: {
    fullName: 'Office Open XML Spreadsheet',
  },
  xls: {
    fullName: 'Microsoft Excel 97-2003 Binary Spreadsheet',
  },
  pptx: {
    fullName: 'Office Open XML Presentation',
  },
  ...MEDIA_FORMAT_SPECIFICATIONS,
  ...PACKAGE_FORMAT_SPECIFICATIONS,
};

type FormatDetailTranslator = ReturnType<typeof useTranslations<'formatDetail'>>;

/** The name of a registry category in the page's language. */
export function formatCategoryLabel(t: FormatDetailTranslator, category: FormatCategory): string {
  return t(`categories.${category}`);
}

/** Reads a format's card in the page's language: a written one, else one built from the registry entry. */
export function useFormatDetail(): (formatKey: string) => FormatSpecification {
  const t = useTranslations('formatDetail');
  const tSpecs = useTranslations('formatSpecs');
  const tDescriptions = useTranslations('formatDescriptions');

  return (formatKey) => {
    const key = formatKey.toLowerCase();
    const known = Object.hasOwn(FORMAT_SPECIFICATIONS, key) ? FORMAT_SPECIFICATIONS[key] : undefined;
    if (known) return { ...known, desc: tSpecs(`${key as 'pdf'}.desc`) };

    const def = FORMAT_REGISTRY[key];
    const name = def?.name || t('fallbackName', { ext: key.toUpperCase() });
    const descriptionKey = def ? formatMessageKey(def.id) : undefined;
    const desc = descriptionKey && tDescriptions.has(descriptionKey) ? tDescriptions(descriptionKey) : t('fallbackDesc', { name });

    return { fullName: name, desc };
  };
}
