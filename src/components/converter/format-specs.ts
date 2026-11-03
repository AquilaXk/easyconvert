import { useTranslations } from 'next-intl';
import { FORMAT_FULL_NAMES } from '@/lib/format-full-names';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { formatMessageKey } from '@/i18n/message-keys';
import type { FormatCategory } from '@/lib/types';

/** A format's card as the page shows it: its full name, which reads the same in every language, and its description in the page's language. */
export interface FormatSpecification {
  fullName: string;
  desc: string;
}

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
    const known = Object.hasOwn(FORMAT_FULL_NAMES, key) ? FORMAT_FULL_NAMES[key] : undefined;
    if (known) return { fullName: known, desc: tSpecs(`${key as 'pdf'}.desc`) };

    const def = FORMAT_REGISTRY[key];
    const name = def?.name || t('fallbackName', { ext: key.toUpperCase() });
    const descriptionKey = def ? formatMessageKey(def.id) : undefined;
    const desc = descriptionKey && tDescriptions.has(descriptionKey) ? tDescriptions(descriptionKey) : t('fallbackDesc', { name });

    return { fullName: name, desc };
  };
}
