import { createTranslator, type Messages } from 'next-intl';
import { testMessages, type TestLocale } from './intl-messages';

export { testMessages, type TestLocale } from './intl-messages';

/** A translator over a locale's messages, for tests that word copy outside a rendered component. */
export function testTranslator<N extends keyof Messages>(locale: TestLocale, namespace: N) {
  return createTranslator({ locale, messages: testMessages(locale), namespace });
}
