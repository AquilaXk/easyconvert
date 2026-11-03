import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getAccessFallbackHTTPStatus, isHTTPAccessFallbackError } from 'next/dist/client/components/http-access-fallback/http-access-fallback';
import ConverterPage, { generateMetadata } from '../src/app/[locale]/[slug]/page';
import NotFoundPageView from '../src/components/pages/NotFoundPageView';
import { routing } from '../src/i18n/routing';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { CATEGORY_WORDS, parseConverterSlug } from '../src/lib/slug-parser';
import { headings, renderDom, select, visibleText } from './helpers/rendered-dom';
import type { TestLocale } from './helpers/intl-messages';

/**
 * A path the site does not offer is answered 404 from the page, in English and under /ko, as the reference converter
 * answers it. The slug page is the only place a path becomes a page, so each class of path is run through the page and its
 * metadata, the two functions a request calls, and the parser the page asks is swept over every pair of the registry.
 */

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
  getTranslations: async ({ locale, namespace }: { locale: 'en' | 'ko'; namespace: 'slugPages' | 'meta.converter' }) =>
    (await import('./helpers/intl')).testTranslator(locale, namespace),
}));

async function statusOf(call: () => unknown): Promise<number> {
  try {
    await call();
    return 200;
  } catch (error) {
    if (isHTTPAccessFallbackError(error)) return getAccessFallbackHTTPStatus(error);
    throw error;
  }
}

const pageStatus = (locale: string, slug: string) => statusOf(() => ConverterPage({ params: Promise.resolve({ locale, slug }) }));
const metadataStatus = (locale: string, slug: string) => statusOf(() => generateMetadata({ params: Promise.resolve({ locale, slug }) }));

const NO_PAGE: Record<string, readonly string[]> = {
  'a name the site does not know': ['nonexistent-page-xyz', 'dpa', 'acceptable-use', 'hello-world', 'forgot-password', 'pdf-to-docx-to-zip'],
  'a name every object has': ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'constructor-converter', 'constructor-to-pdf', 'pdf-to-constructor'],
  'a converter of a format that is not registered': ['foo-converter', 'any-converter', 'xyz-converter', '-converter', 'converter-converter'],
  'a pair with a name that is not registered': ['foo-to-bar', 'pdf-to-foo', 'foo-to-pdf', 'png-to-xyz', '-to-pdf', 'pdf-to-', '-to-'],
  'a pair with any on either side': ['pdf-to-any', 'any-to-pdf', 'any-to-any'],
  'a pair with a category word on either side': [
    'video-to-mp4', 'mp4-to-video', 'video-to-video', 'image-to-pdf', 'pdf-to-image', 'image-to-photo', 'video-to-gif', 'video-to-mp3', 'word-to-pdf', 'pdf-to-word',
    'presentation-to-pdf',
  ],
  'registered formats whose conversion the registry does not offer': ['mp3-to-pdf', 'docx-to-mp3', 'jpg-to-jpeg', 'docx-to-docx', 'htm-to-html', 'txt-to-txt'],
  'a word that names a category the registry does not have': ['word-converter', 'excel-converter', 'powerpoint-converter', 'photo-converter', 'picture-converter', 'music-converter'],
  'the OCR page under a name other than its own': ['ocr', 'ocr-pdf', 'pdf-to-ocr', 'ocr-to-pdf'],
  'a utility page of a format it does not support': ['merge-xyz', 'merge-docx', 'merge-jpg', 'compress-gif', 'compress-docx', 'compress-xyz', 'merge-', 'compress-'],
  'a path that names a file': ['backup.zip', 'foo-to-bar.php', 'x.php-converter', 'zip-to-x.tar.gz', 'pdf-to-docx.php'],
};

const PAGE: Record<string, readonly string[]> = {
  'a registered pair the registry offers': ['jpg-to-pdf', 'png-to-jpg', 'pdf-to-docx', 'mp4-to-mp3', 'heic-to-jpg', 'csv-to-json', 'zip-to-tar.gz', 'tar.gz-to-zip', 'PDF-to-JPG'],
  'a format converted to itself or to its other name': ['jpeg-to-jpg', 'jfif-to-jpg', 'mp4-to-mp4', 'pdf-to-pdf', 'png-to-png', 'tif-to-tiff'],
  'the converter of a format or a category': ['pdf-converter', 'jpeg-converter', 'tar.gz-converter', 'video-converter', 'image-converter', 'document-converter', 'data-converter', 'Video-Converter'],
  'the OCR page': ['pdf-ocr'],
  'a utility page of a format it supports': ['merge-pdf', 'compress-pdf', 'compress-png', 'compress-jpg', 'save-website-as-pdf', 'website-png-screenshot', 'website-jpg-screenshot'],
  'a unit pair': ['lbs-to-kg', 'kg-to-lbs', 'feet-to-meters', 'meters-to-feet'],
  'a site page': ['terms', 'privacy', 'security', 'about', 'contact', 'accessibility', 'status'],
};

describe('a path the site does not offer is answered 404 in every locale', () => {
  for (const [kind, slugs] of Object.entries(NO_PAGE)) {
    it(`answers 404 for ${kind}, from the page and from its metadata`, async () => {
      const wrong: string[] = [];
      for (const locale of routing.locales) {
        for (const slug of slugs) {
          const [page, metadata] = await Promise.all([pageStatus(locale, slug), metadataStatus(locale, slug)]);
          if (page !== 404 || metadata !== 404) wrong.push(`${locale} /${slug}: page ${page}, metadata ${metadata}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  for (const [kind, slugs] of Object.entries(PAGE)) {
    it(`still answers 200 for ${kind}, with its own title and canonical`, async () => {
      const wrong: string[] = [];
      for (const locale of routing.locales) {
        for (const slug of slugs) {
          const [page, metadata] = await Promise.all([pageStatus(locale, slug), generateMetadata({ params: Promise.resolve({ locale, slug }) })]);
          if (page !== 200 || !metadata.title || !metadata.alternates?.canonical) wrong.push(`${locale} /${slug}: page ${page}, metadata ${JSON.stringify(metadata)}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});

describe('the parser reads a pair as a page exactly when the registry offers it', () => {
  const ids = Object.keys(FORMAT_REGISTRY);
  const isCategoryWord = (id: string) => Object.hasOwn(CATEGORY_WORDS, id);

  it('finds a page for every conversion the registry lists between two format names, and for no other pair', () => {
    const wrong: string[] = [];
    let pages = 0;
    for (const source of ids) {
      for (const target of ids) {
        const offered = !isCategoryWord(source) && !isCategoryWord(target) && FORMAT_REGISTRY[source].targetFormats.includes(target);
        const parsed = parseConverterSlug(`${source}-to-${target}`);
        if (offered) pages++;
        if (Boolean(parsed) !== offered) wrong.push(`${source}-to-${target}: ${offered ? 'offered, no page' : 'not offered, page'}`);
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
    expect(pages).toBeGreaterThan(2400);
  });

  it('finds the converter page of every registered format and of every category the registry has, and no other converter page', () => {
    const categories = new Set(Object.values(FORMAT_REGISTRY).map((definition) => definition.category));
    expect(Object.keys(CATEGORY_WORDS).sort()).toEqual([...categories].sort());
    for (const id of ids) expect(parseConverterSlug(`${id}-converter`), `${id}-converter`).not.toBeNull();
    for (const word of categories) expect(parseConverterSlug(`${word}-converter`), `${word}-converter`).not.toBeNull();
  });
});

describe('the page a path with no page shows', () => {
  const WORDING: Record<TestLocale, { code: string; title: string; description: string }> = {
    en: { code: '404', title: 'The page could not be found.', description: 'Sorry, the page you are looking for could not be found.' },
    ko: { code: '페이지 없음', title: '페이지를 찾을 수 없어요.', description: '찾으시는 페이지를 찾을 수 없어요.' },
  };

  it.each(routing.locales)('says the page was not found in %s under the header, as a code, a heading and one sentence, with no footer', (locale) => {
    const page = renderDom(createElement(NotFoundPageView), locale);
    const main = select(page, 'main')[0];
    expect(headings(main)).toEqual([WORDING[locale].title]);
    expect(visibleText(main)).toBe(`${WORDING[locale].code} ${WORDING[locale].title} ${WORDING[locale].description}`);
    expect(select(page, 'header')).toHaveLength(1);
    expect(select(page, 'footer')).toHaveLength(0);
  });
});
