import { createTranslator, type Messages } from 'next-intl';
import enMessages from '../../../messages/en.json';
import koMessages from '../../../messages/ko.json';
import { findApiDocTopic } from '@/components/api-docs/topics';
import { localizeSlugCopy } from '@/components/converter/slug-copy';
import { routing, type AppLocale } from '@/i18n/routing';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from '@/lib/legal/documents';
import { FORMAT_REGISTRY } from '@/lib/registry';
import { parseConverterSlug } from '@/lib/slug-parser';
import type { FormatCategory } from '@/lib/types';

/**
 * Resolves the localized social preview card model strictly from canonical `(locale, pathname)`
 * pairs against the site's own message tables and format registry.
 *
 * Refusing arbitrary query-supplied `title` / `description` text prevents brand-impersonation
 * phishing links on `/api/og` and guarantees that every rendered code point belongs to the
 * verified glyph subset of `EasyConvertSans-{latin,hangul}.woff2`.
 */

export interface OgCardSpec {
  locale: AppLocale;
  pathname: string;
  eyebrow: string;
  headline: string;
  description: string;
  sourceBadge?: string;
  targetBadge?: string;
  pills?: readonly string[];
  footerRight: string;
}

const MAX_OG_PATH_LENGTH = 256;
const FORMAT_COUNT = Object.keys(FORMAT_REGISTRY).length;

const MESSAGES_BY_LOCALE: Readonly<Record<AppLocale, Messages>> = {
  en: enMessages as unknown as Messages,
  ko: koMessages as unknown as Messages,
};

const LEGAL_BY_PATH: ReadonlyMap<string, LegalDocumentId> = new Map(
  (Object.entries(LEGAL_DOCUMENTS) as Array<[LegalDocumentId, { path: string }]>).map(([id, doc]) => [doc.path, id])
);

const CATEGORY_NAME_KEY: Readonly<Record<FormatCategory, keyof Messages['slugPages']['names']>> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  vector: 'Vector',
  document: 'Document',
  subtitle: 'Document',
  spreadsheet: 'Spreadsheet',
  archive: 'Archive',
  presentation: 'Presentation',
  ebook: 'Ebook',
  data: 'Data',
  font: 'Font',
  cad: 'CAD',
};

const HOME_PILLS: Readonly<Record<AppLocale, readonly string[]>> = {
  en: ['DOCUMENTS', 'IMAGES', 'VIDEO & AUDIO', 'ARCHIVES'],
  ko: ['문서', '이미지', '동영상 · 오디오', '압축 파일'],
};

const FOOTER_RIGHT: Readonly<Record<AppLocale, string>> = {
  en: `${FORMAT_COUNT} Formats · Encrypted · Auto-Deleted`,
  ko: `${FORMAT_COUNT}개 형식 · 암호화 전송 · 자동 삭제`,
};

export function isValidOgLocale(raw: string): raw is AppLocale {
  return (routing.locales as readonly string[]).includes(raw);
}

export function validateOgPathname(raw: string): string | null {
  if (!raw || raw.length > MAX_OG_PATH_LENGTH) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/[\s?#\\]/.test(raw)) return null;
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function stripBrandSuffix(title: string): string {
  return title
    .replace(/\s*\|\s*EasyConvert$/i, '')
    .replace(/^EasyConvert\s*\|\s*/i, '')
    .trim();
}

function truncateDescription(text: string, locale: AppLocale): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const limit = locale === 'ko' ? 112 : 152;
  if (clean.length <= limit) return clean;

  // Prefer ending cleanly on a complete sentence boundary before falling back to an ellipsis
  const sentences = clean.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) {
    let joined = '';
    for (const sentence of sentences) {
      const candidate = joined ? `${joined} ${sentence}` : sentence;
      if (candidate.length > limit) break;
      joined = candidate;
    }
    if (joined.length >= 24) return joined;
  }

  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  const stem = lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${stem.replace(/[.,;:\s]+$/, '')}...`;
}

async function resolveStaticPageSpec(locale: AppLocale, pathname: string, messages: Messages): Promise<OgCardSpec | null> {
  const footerRight = FOOTER_RIGHT[locale];
  if (pathname === '/') {
    const t = createTranslator({ locale, messages, namespace: 'meta.home' });
    return {
      locale,
      pathname,
      eyebrow: locale === 'ko' ? `${FORMAT_COUNT}개 형식 · 무료` : `${FORMAT_COUNT} FORMATS · ONLINE`,
      headline: stripBrandSuffix(t('title')),
      description: truncateDescription(t('description'), locale),
      pills: HOME_PILLS[locale],
      footerRight,
    };
  }
  if (pathname === '/pricing') {
    const t = createTranslator({ locale, messages, namespace: 'meta.pricing' });
    return {
      locale,
      pathname,
      eyebrow: locale === 'ko' ? '요금' : 'PRICING',
      headline: stripBrandSuffix(t('title')),
      description: truncateDescription(t('description'), locale),
      footerRight,
    };
  }
  if (pathname === '/api-docs') {
    const t = createTranslator({ locale, messages, namespace: 'meta.apiDocs' });
    return {
      locale,
      pathname,
      eyebrow: 'DEVELOPER API',
      headline: stripBrandSuffix(t('title')),
      description: truncateDescription(t('description'), locale),
      pills: ['REST v1', 'TUS', 'WEBHOOKS'],
      footerRight,
    };
  }
  if (pathname.startsWith('/api-docs/')) {
    const slug = pathname.slice('/api-docs/'.length);
    const topic = findApiDocTopic(slug);
    if (!topic || topic.slug === 'introduction') return null;
    const t = createTranslator({ locale, messages, namespace: 'apiDocs' });
    return {
      locale,
      pathname,
      eyebrow: 'DEVELOPER API',
      headline: t(`topics.${topic.slug}.title`),
      description: truncateDescription(t(`topics.${topic.slug}.lead`), locale),
      footerRight,
    };
  }
  const legalId = LEGAL_BY_PATH.get(pathname);
  if (legalId) {
    const { legalPage } = await import('@/lib/legal/render');
    const doc = legalPage(legalId, locale);
    return {
      locale,
      pathname,
      eyebrow: locale === 'ko' ? '문서' : 'LEGAL',
      headline: doc.title,
      description: truncateDescription(doc.summary, locale),
      footerRight,
    };
  }
  return null;
}

function resolveSingleBadge(parsed: NonNullable<ReturnType<typeof parseConverterSlug>>): string | undefined {
  if (parsed.isInfoPage) return undefined;
  if (parsed.copy.kind === 'format' && parsed.copy.name.kind === 'format') {
    return parsed.copy.name.display;
  }
  return parsed.sourceFormat ? parsed.sourceFormat.toUpperCase() : undefined;
}

export async function resolveOgCardSpec(locale: AppLocale, pathname: string): Promise<OgCardSpec | null> {
  const messages = MESSAGES_BY_LOCALE[locale];
  const staticSpec = await resolveStaticPageSpec(locale, pathname, messages);
  if (staticSpec) return staticSpec;

  const rawSlug = pathname.slice(1);
  if (!rawSlug || rawSlug.includes('/')) return null;
  const parsed = parseConverterSlug(rawSlug);
  if (!parsed) return null;

  const tSlug = createTranslator({ locale, messages, namespace: 'slugPages' });
  const copy = localizeSlugCopy(tSlug, parsed, locale);
  const srcCategory = FORMAT_REGISTRY[parsed.sourceFormat]?.category;
  const categoryLabel = srcCategory
    ? tSlug(`names.${CATEGORY_NAME_KEY[srcCategory]}`).toUpperCase()
    : 'CONVERTER';

  if (parsed.copy.kind === 'pair') {
    return {
      locale,
      pathname: parsed.canonicalPath,
      eyebrow: categoryLabel,
      headline: copy.title,
      description: truncateDescription(copy.description, locale),
      sourceBadge: parsed.copy.src.toUpperCase(),
      targetBadge: parsed.copy.tgt.toUpperCase(),
      footerRight: FOOTER_RIGHT[locale],
    };
  }

  const singleBadge = resolveSingleBadge(parsed);

  return {
    locale,
    pathname: parsed.canonicalPath,
    eyebrow: categoryLabel,
    headline: copy.title,
    description: truncateDescription(copy.description, locale),
    ...(singleBadge ? { sourceBadge: singleBadge } : {}),
    footerRight: FOOTER_RIGHT[locale],
  };
}
