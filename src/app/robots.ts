import type { MetadataRoute } from 'next';
import { siteMetadataBase } from '@/i18n/metadata';

const DEFAULT_PUBLIC_ORIGIN = 'https://convert.aquilaxk.site';

export default function robots(): MetadataRoute.Robots {
  const origin = siteMetadataBase()?.origin ?? DEFAULT_PUBLIC_ORIGIN;
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/api/og'],
      disallow: [
        '/api/',
        '/dashboard/',
        '/account/',
        '/auth/',
        '/ko/dashboard/',
        '/ko/account/',
        '/ko/auth/',
      ],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
