import { createTranslator, type Messages, type NamespaceKeys, type NestedKeyOf } from 'next-intl';
import { localizeSlugCopy } from '../../src/components/converter/slug-copy';
import { parseConverterSlug } from '../../src/lib/slug-parser';
import { testMessages, type TestLocale } from './intl-messages';

export { testMessages, type TestLocale } from './intl-messages';

/** A translator over a locale's messages, for tests that word copy outside a rendered component. */
export function testTranslator<N extends NamespaceKeys<Messages, NestedKeyOf<Messages>>>(locale: TestLocale, namespace: N) {
  return createTranslator({ locale, messages: testMessages(locale), namespace });
}

/** The title and description of a slug page in `locale` (English by default), as the converter page words them. */
export function slugPageCopy(slug: string, locale: TestLocale = 'en') {
  return localizeSlugCopy(testTranslator(locale, 'slugPages'), parseConverterSlug(slug), locale);
}
