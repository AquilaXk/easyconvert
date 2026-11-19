import type { MetadataRoute } from 'next';
import { API_DOC_SUBPAGES, apiDocsHref } from '@/components/api-docs/topics';
import { siteMetadataBase } from '@/i18n/metadata';
import { getPathname } from '@/i18n/navigation';
import { CATEGORY_WORDS } from '@/lib/category-words';
import { COMPRESSED_IMAGE_FORMATS } from '@/lib/image-compression';
import { MERGE_FORMATS } from '@/lib/jobs/graph-operations';
import { OPTIMIZABLE_FORMATS } from '@/lib/jobs/optimize-formats';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { INFO_PAGE_MAP, PAGE_TOOL_SLUGS } from '@/lib/slug-info-pages';
import { parseConverterSlug } from '@/lib/slug-parser';

const DEFAULT_PUBLIC_ORIGIN = 'https://convert.aquilaxk.site';

/** Public top-level pages under `src/app/[locale]` (excluding session/auth/redirect routes `/dashboard`, `/account`, `/auth`). */
const PUBLIC_STATIC_PATHS = [
  '/',
  '/api-docs',
  ...API_DOC_SUBPAGES.map((topic) => apiDocsHref(topic.slug)),
  '/pricing',
  '/privacy',
  '/terms',
  '/acceptable-use',
  '/dpa',
] as const;

const PUBLIC_STATIC_PATH_SET: ReadonlySet<string> = new Set(PUBLIC_STATIC_PATHS);

function routePriority(pathname: string): number {
  if (pathname === '/') return 1.0;
  return PUBLIC_STATIC_PATH_SET.has(pathname) ? 0.8 : 0.7;
}

function collectCanonicalPublicPaths(): string[] {
  const websiteCaptureEnabled = process.env.CAPTURE_WEBSITE_ENABLED === 'true';
  const paths = new Set<string>(PUBLIC_STATIC_PATHS);

  const candidates: string[] = [
    ...Object.keys(INFO_PAGE_MAP),
    'pdf-ocr',
    'pdfa-converter',
    ...Object.values(PAGE_TOOL_SLUGS),
    ...Object.keys(CATEGORY_WORDS).map((word) => `${word}-converter`),
    ...Object.keys(FORMAT_REGISTRY).map((fmt) => `${fmt}-converter`),
    ...[...MERGE_FORMATS].map((fmt) => `merge-${fmt}`),
    ...[...OPTIMIZABLE_FORMATS, ...COMPRESSED_IMAGE_FORMATS].map((fmt) => `compress-${fmt}`),
    'save-website-as-pdf',
    'website-png-screenshot',
    'website-jpg-screenshot',
  ];

  for (const [src, def] of Object.entries(FORMAT_REGISTRY)) {
    for (const tgt of def.targetFormats) {
      candidates.push(`${src}-to-${tgt}`);
    }
  }

  for (const slug of candidates) {
    const parsed = parseConverterSlug(slug);
    if (!parsed || parsed.canonicalPath !== `/${slug}`) continue;
    if (!websiteCaptureEnabled && (parsed.copy.kind === 'saveWebsiteAsPdf' || parsed.copy.kind === 'websiteScreenshot')) {
      continue;
    }
    paths.add(parsed.canonicalPath);
  }

  return [...paths];
}

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteMetadataBase()?.origin ?? DEFAULT_PUBLIC_ORIGIN;
  const canonicalPaths = collectCanonicalPublicPaths();
  const entries: MetadataRoute.Sitemap = [];

  for (const pathname of canonicalPaths) {
    const enUrl = `${origin}${getPathname({ locale: 'en', href: pathname })}`;
    const koUrl = `${origin}${getPathname({ locale: 'ko', href: pathname })}`;
    const languages = {
      en: enUrl,
      ko: koUrl,
      'x-default': enUrl,
    };
    const priority = routePriority(pathname);

    entries.push(
      { url: enUrl, changeFrequency: 'weekly', priority, alternates: { languages } },
      { url: koUrl, changeFrequency: 'weekly', priority, alternates: { languages } }
    );
  }

  return entries;
}
