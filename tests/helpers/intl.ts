import { createTranslator, type Messages, type NamespaceKeys, type NestedKeyOf } from 'next-intl';
import { localizeSlugCopy } from '../../src/components/converter/slug-copy';
import { parseConverterSlug } from '../../src/lib/slug-parser';
import { testMessages, type TestLocale } from './intl-messages';

export { testMessages, type TestLocale } from './intl-messages';

/** A translator over a locale's messages, for tests that word copy outside a rendered component. */
export function testTranslator<N extends NamespaceKeys<Messages, NestedKeyOf<Messages>>>(locale: TestLocale, namespace: N) {
  return createTranslator({ locale, messages: testMessages(locale), namespace });
}

/** The English title and description of a slug page, as the converter page words them. */
export function englishSlugCopy(slug: string) {
  return localizeSlugCopy(testTranslator('en', 'slugPages'), parseConverterSlug(slug).copy);
}
