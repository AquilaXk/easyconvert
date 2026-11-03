import { useTranslations } from 'next-intl';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { formatMessageKey } from '@/i18n/message-keys';
import { MEDIA_FORMAT_SPECIFICATIONS } from './format-specs-media';
import { PACKAGE_FORMAT_SPECIFICATIONS } from './format-specs-packages';

/** The facts of a format that read the same in every language: names, maintainers, MIME type, category key. */
export interface FormatFacts {
  title: string;
  fullName: string;
  developer: string;
  mimeType: string;
  category: string;
  extension: string;
}

/** A format's dossier as the page shows it, its prose in the page's language. */
export interface FormatSpecification extends FormatFacts {
  categoryLabel: string;
  desc: string;
  advantages: string[];
}

/** The formats with a written dossier; their prose is `formatSpecs.<id>` in the messages. */
export const FORMAT_SPECIFICATIONS: Record<string, FormatFacts> = {
  pdf: {
    title: 'PDF (Portable Document Format)',
    fullName: 'Portable Document Format',
    developer: 'Adobe Systems / ISO 32000',
    mimeType: 'application/pdf',
    category: 'document',
    extension: 'pdf',
  },
  docx: {
    title: 'DOCX (Microsoft Word Document)',
    fullName: 'Office Open XML Document',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'document',
    extension: 'docx',
  },
  doc: {
    title: 'DOC (Legacy Microsoft Word Document)',
    fullName: 'Microsoft Word 97-2003 Binary Document',
    developer: 'Microsoft Corporation',
    mimeType: 'application/msword',
    category: 'document',
    extension: 'doc',
  },
  csv: {
    title: 'CSV (Comma-Separated Values)',
    fullName: 'Comma-Separated Values',
    developer: 'Internet Engineering Task Force (IETF / RFC 4180)',
    mimeType: 'text/csv',
    category: 'data',
    extension: 'csv',
  },
  json: {
    title: 'JSON (JavaScript Object Notation)',
    fullName: 'JavaScript Object Notation',
    developer: 'Douglas Crockford / ECMA International (ECMA-404)',
    mimeType: 'application/json',
    category: 'data',
    extension: 'json',
  },
  xlsx: {
    title: 'XLSX (Microsoft Excel Spreadsheet)',
    fullName: 'Office Open XML Spreadsheet',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'spreadsheet',
    extension: 'xlsx',
  },
  xls: {
    title: 'XLS (Legacy Microsoft Excel Spreadsheet)',
    fullName: 'Microsoft Excel 97-2003 Binary Spreadsheet',
    developer: 'Microsoft Corporation',
    mimeType: 'application/vnd.ms-excel',
    category: 'spreadsheet',
    extension: 'xls',
  },
  pptx: {
    title: 'PPTX (Microsoft PowerPoint Presentation)',
    fullName: 'Office Open XML Presentation',
    developer: 'Microsoft Corporation / ISO/IEC 29500',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    category: 'presentation',
    extension: 'pptx',
  },
  ...MEDIA_FORMAT_SPECIFICATIONS,
  ...PACKAGE_FORMAT_SPECIFICATIONS,
};

const DOSSIER_CATEGORIES = new Set([
  'audio', 'video', 'image', 'vector', 'document', 'spreadsheet', 'presentation', 'archive', 'ebook', 'font', 'cad', 'data',
]);
const CATEGORY_DEVELOPERS = new Set(['audio', 'video', 'image', 'document', 'archive', 'spreadsheet', 'ebook', 'cad', 'font']);

type FormatDetailTranslator = ReturnType<typeof useTranslations<'formatDetail'>>;

export function formatCategoryLabel(t: FormatDetailTranslator, category: string): string {
  const key = category?.toLowerCase();
  return DOSSIER_CATEGORIES.has(key) ? t(`categories.${key as 'audio'}`) : t('categories.fallback');
}

/** Reads a format's dossier in the page's language: a written one, else one built from the registry entry. */
export function useFormatDetail(): (formatKey: string) => FormatSpecification {
  const t = useTranslations('formatDetail');
  const tSpecs = useTranslations('formatSpecs');
  const tDescriptions = useTranslations('formatDescriptions');

  return (formatKey) => {
    const key = formatKey.toLowerCase();
    const known = Object.hasOwn(FORMAT_SPECIFICATIONS, key) ? FORMAT_SPECIFICATIONS[key] : undefined;
    if (known) {
      const specKey = key as 'pdf';
      return {
        ...known,
        categoryLabel: formatCategoryLabel(t, known.category),
        desc: tSpecs(`${specKey}.desc`),
        advantages: [tSpecs(`${specKey}.adv1`), tSpecs(`${specKey}.adv2`), tSpecs(`${specKey}.adv3`)],
      };
    }

    const def = FORMAT_REGISTRY[key];
    const ext = def?.extension || key;
    const name = def?.name || t('fallbackName', { ext: ext.toUpperCase() });
    const category = def?.category || 'document';
    const categoryLabel = formatCategoryLabel(t, category);
    const descriptionKey = def ? formatMessageKey(def.id) : undefined;
    const desc = descriptionKey && tDescriptions.has(descriptionKey) ? tDescriptions(descriptionKey) : t('fallbackDesc', { name });

    return {
      title: `${ext.toUpperCase()} (${name})`,
      fullName: name,
      developer: CATEGORY_DEVELOPERS.has(category) ? t(`developers.${category as 'audio'}`) : t('developers.fallback'),
      mimeType: def?.mimeType || `application/${ext}`,
      category,
      extension: ext,
      categoryLabel,
      desc,
      advantages: [t('advantages.sandbox')],
    };
  };
}
