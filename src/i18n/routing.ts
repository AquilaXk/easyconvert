import { defineRouting } from 'next-intl/routing';

/** The cookie that remembers a chosen language for the root's negotiation; only the language selector writes it. */
export const LOCALE_COOKIE = { name: 'NEXT_LOCALE', sameSite: 'lax' } as const;

export const routing = defineRouting({
  locales: ['en', 'ko'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  localeCookie: LOCALE_COOKIE,
  // The page metadata names the alternates as absolute URLs on the public origin; next-intl's Link header would build
  // them from the request's host and the raw slug, so it is off and the metadata is the one source.
  alternateLinks: false,
});

export type AppLocale = (typeof routing.locales)[number];
