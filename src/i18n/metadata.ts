import type { Metadata } from 'next';
import { getPathname } from './navigation';
import { routing, type AppLocale } from './routing';

export const PUBLIC_DEFAULT_ORIGIN = 'https://convert.aquilaxk.site';
const OG_ROUTE_PATH = '/api/og';
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
const OG_LOCALE: Readonly<Record<AppLocale, string>> = {
  en: 'en_US',
  ko: 'ko_KR',
};

/** Root-relative URL of the localized 1200x630 OpenGraph / Twitter / KakaoTalk preview card for `pathname`. */
export function socialCardImageUrl(locale: AppLocale, pathname: string): string {
  const params = new URLSearchParams({ locale, path: pathname });
  return `${OG_ROUTE_PATH}?${params.toString()}`;
}

/**
 * The origin page metadata resolves its URLs against: the public origin the image is built with (`APP_ORIGIN`, which the
 * web image's build requires). Without one, as in tests and `next dev`, the alternate and canonical links stay root-relative.
 */
export function siteMetadataBase(): URL | undefined {
  const origin = process.env.APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (!origin && process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
    throw new Error('APP_ORIGIN must be configured in production runtime.');
  }
  return origin ? new URL(origin) : undefined;
}

/** Canonical URL of `pathname` in `locale`, and its hreflang alternates in every locale (English as x-default). */
export function localeAlternates(locale: AppLocale, pathname: string): Metadata['alternates'] {
  const href = (target: AppLocale) => getPathname({ locale: target, href: pathname });
  const languages: Record<string, string> = Object.fromEntries(routing.locales.map((target) => [target, href(target)]));
  languages['x-default'] = href(routing.defaultLocale);
  return { canonical: href(locale), languages };
}

/** OpenGraph and Twitter card metadata for any public localized page. */
export function socialMetadata(
  locale: AppLocale,
  pathname: string,
  title: string,
  description: string
): Pick<Metadata, 'openGraph' | 'twitter'> {
  const url = getPathname({ locale, href: pathname });
  const imageUrl = socialCardImageUrl(locale, pathname);
  return {
    openGraph: {
      type: 'website',
      siteName: 'EasyConvert',
      locale: OG_LOCALE[locale],
      url,
      title,
      description,
      images: [
        {
          url: imageUrl,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          type: 'image/png',
          alt: title,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [
        {
          url: imageUrl,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          alt: title,
        },
      ],
    },
  };
}

/** Escapes `<` so serialized JSON-LD is safe inside a `<script type="application/ld+json">` tag. */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** Schema.org `WebApplication` structured data for the home page and converter landing pages. */
export function webApplicationJsonLd(params: {
  locale: AppLocale;
  pathname: string;
  name: string;
  description: string;
}): string {
  const origin = siteMetadataBase()?.origin ?? PUBLIC_DEFAULT_ORIGIN;
  const url = `${origin}${getPathname({ locale: params.locale, href: params.pathname })}`;
  return serializeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: params.name,
    description: params.description,
    url,
    inLanguage: params.locale,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'All',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  });
}
