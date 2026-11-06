import { CATEGORY_LABELS, FORMAT_REGISTRY } from '@/lib/registry';
import { formatMessageKey } from './message-keys';
import type { AppLocale } from './routing';

/**
 * The registry's English format descriptions and category labels are the source of that copy, so the English messages
 * read them from there instead of keeping a second copy; every other language keeps its translation in its own file
 * (`formatDescriptions`, `formatCategories`).
 */
function registryCopy() {
  return {
    formatDescriptions: Object.fromEntries(
      Object.values(FORMAT_REGISTRY).map((format) => [formatMessageKey(format.id), format.description])
    ),
    formatCategories: { ...CATEGORY_LABELS },
  };
}

const completedEnglish = new WeakMap<object, object>();

/**
 * A locale's messages from its file, completed with the copy English reads from the registry. The
 * English set is assembled once per messages file, since every page render reads it.
 */
export function completeMessages<M extends object>(locale: AppLocale, fileMessages: M) {
  if (locale !== 'en') return fileMessages;
  const cached = completedEnglish.get(fileMessages) as (M & ReturnType<typeof registryCopy>) | undefined;
  if (cached) return cached;
  const completed = { ...fileMessages, ...registryCopy() };
  completedEnglish.set(fileMessages, completed);
  return completed;
}

export async function loadMessages(locale: AppLocale) {
  return completeMessages(locale, (await import(`../../messages/${locale}.json`)).default);
}
