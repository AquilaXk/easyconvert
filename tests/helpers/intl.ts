import { createTranslator, type Messages, type NamespaceKeys, type NestedKeyOf } from 'next-intl';
import { testMessages, type TestLocale } from './intl-messages';

export { testMessages, type TestLocale } from './intl-messages';

/** A translator over a locale's messages, for tests that word copy outside a rendered component. */
export function testTranslator<N extends NamespaceKeys<Messages, NestedKeyOf<Messages>>>(locale: TestLocale, namespace: N) {
  return createTranslator({ locale, messages: testMessages(locale), namespace });
}
