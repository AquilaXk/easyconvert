import { FORMAT_REGISTRY } from '@/lib/registry';
import type { AppLocale } from './routing';

/**
 * The registry's English descriptions are the source of every format's description, so the English messages read them
 * from it instead of keeping a copy; every other language keeps its translation in `formatDescriptions` of its file.
 */
function registryDescriptions(): Record<string, string> {
  return Object.fromEntries(Object.values(FORMAT_REGISTRY).map((format) => [format.id, format.description]));
}

export async function loadMessages(locale: AppLocale) {
  const messages = (await import(`../../messages/${locale}.json`)).default;
  return locale === 'en' ? { ...messages, formatDescriptions: registryDescriptions() } : messages;
}
