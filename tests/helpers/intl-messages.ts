import type { Messages } from 'next-intl';
import en from '../../messages/en.json';
import ko from '../../messages/ko.json';
import { completeMessages } from '../../src/i18n/messages';

export type TestLocale = 'en' | 'ko';

/** The messages a page in `locale` reads, assembled as `src/i18n/request.ts` does. */
export function testMessages(locale: TestLocale): Messages {
  return completeMessages(locale, locale === 'en' ? en : ko) as Messages;
}

/**
 * `next-intl` with its hooks read from the English messages instead of a provider, for tests that call a component as a
 * plain function (outside a render, where there is no context to read). It imports nothing from `next-intl` itself, so a
 * `vi.mock('next-intl', ...)` factory can load it.
 */
export async function contextFreeNextIntl(importOriginal: () => Promise<typeof import('next-intl')>) {
  const actual = await importOriginal();
  const messages = testMessages('en');
  return {
    ...actual,
    useLocale: () => 'en',
    useTranslations: (namespace?: string) =>
      actual.createTranslator({ locale: 'en', messages, namespace: namespace as keyof Messages }),
    useFormatter: () => actual.createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
}
