import type { Metadata } from 'next';
import { getPathname } from './navigation';
import { routing, type AppLocale } from './routing';

/**
 * The origin page metadata resolves its URLs against: the configured public origin when the build knows it. Without one
 * the alternate and canonical links stay root-relative, and the middleware's `Link` header names the absolute alternates.
 */
export function siteMetadataBase(): URL | undefined {
  const origin = process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL;
  return origin ? new URL(origin) : undefined;
}

/** Canonical URL of `pathname` in `locale`, and its hreflang alternates in every locale (English as x-default). */
export function localeAlternates(locale: AppLocale, pathname: string): Metadata['alternates'] {
  const href = (target: AppLocale) => getPathname({ locale: target, href: pathname });
  const languages: Record<string, string> = Object.fromEntries(routing.locales.map((target) => [target, href(target)]));
  languages['x-default'] = href(routing.defaultLocale);
  return { canonical: href(locale), languages };
}
