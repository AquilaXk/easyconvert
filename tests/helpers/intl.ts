import { createTranslator, type Messages, type NamespaceKeys, type NestedKeyOf } from 'next-intl';
import { localizeSlugCopy } from '../../src/components/converter/slug-copy';
import { parseConverterSlug, type ParsedSlug } from '../../src/lib/slug-parser';
import { testMessages, type TestLocale } from './intl-messages';

export { testMessages, type TestLocale } from './intl-messages';

/** A translator over a locale's messages, for tests that word copy outside a rendered component. */
export function testTranslator<N extends NamespaceKeys<Messages, NestedKeyOf<Messages>>>(locale: TestLocale, namespace: N) {
  return createTranslator({ locale, messages: testMessages(locale), namespace });
}

/** The page a slug is; a slug the site offers no page at fails the test that asked for it. */
export function parsedSlug(slug: string): ParsedSlug {
  const parsed = parseConverterSlug(slug);
  if (!parsed) throw new Error(`/${slug} is no page`);
  return parsed;
}

/** The title and description of a slug page in `locale` (English by default), as the converter page words them. */
export function slugPageCopy(slug: string, locale: TestLocale = 'en') {
  return localizeSlugCopy(testTranslator(locale, 'slugPages'), parsedSlug(slug), locale);
}
