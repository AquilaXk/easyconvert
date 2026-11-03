import { useTranslations } from 'next-intl';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { formatMessageKey } from '@/i18n/message-keys';
import { MEDIA_FORMAT_SPECIFICATIONS } from './format-specs-media';
import { PACKAGE_FORMAT_SPECIFICATIONS } from './format-specs-packages';

/** The facts of a format that read the same in every language: its full name and extension. */
export interface FormatFacts {
  fullName: string;
  extension: string;
}

/** A format's card as the page shows it, its description in the page's language. */
export interface FormatSpecification extends FormatFacts {
  desc: string;
}

/** The formats with a written description; it is `formatSpecs.<id>.desc` in the messages. */
export const FORMAT_SPECIFICATIONS: Record<string, FormatFacts> = {
  pdf: {
    fullName: 'Portable Document Format',
    extension: 'pdf',
  },
  docx: {
    fullName: 'Office Open XML Document',
    extension: 'docx',
  },
  doc: {
    fullName: 'Microsoft Word 97-2003 Binary Document',
    extension: 'doc',
  },
  csv: {
    fullName: 'Comma-Separated Values',
    extension: 'csv',
  },
  json: {
    fullName: 'JavaScript Object Notation',
    extension: 'json',
  },
  xlsx: {
    fullName: 'Office Open XML Spreadsheet',
    extension: 'xlsx',
  },
  xls: {
    fullName: 'Microsoft Excel 97-2003 Binary Spreadsheet',
    extension: 'xls',
  },
  pptx: {
    fullName: 'Office Open XML Presentation',
    extension: 'pptx',
  },
  ...MEDIA_FORMAT_SPECIFICATIONS,
  ...PACKAGE_FORMAT_SPECIFICATIONS,
};

const DOSSIER_CATEGORIES = new Set([
  'audio', 'video', 'image', 'vector', 'document', 'spreadsheet', 'presentation', 'archive', 'ebook', 'font', 'cad', 'data',
]);

type FormatDetailTranslator = ReturnType<typeof useTranslations<'formatDetail'>>;

export function formatCategoryLabel(t: FormatDetailTranslator, category: string): string {
  const key = category?.toLowerCase();
  return DOSSIER_CATEGORIES.has(key) ? t(`categories.${key as 'audio'}`) : t('categories.fallback');
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
    const ext = def?.extension || key;
    const name = def?.name || t('fallbackName', { ext: ext.toUpperCase() });
    const descriptionKey = def ? formatMessageKey(def.id) : undefined;
    const desc = descriptionKey && tDescriptions.has(descriptionKey) ? tDescriptions(descriptionKey) : t('fallbackDesc', { name });

    return { fullName: name, extension: ext, desc };
  };
}
