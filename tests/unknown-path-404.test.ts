import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getAccessFallbackHTTPStatus, isHTTPAccessFallbackError } from 'next/dist/client/components/http-access-fallback/http-access-fallback';
import ConverterPage, { generateMetadata } from '../src/app/[locale]/[slug]/page';
import UnknownPathPage from '../src/app/[locale]/[...rest]/page';
import { generateMetadata as notFoundMetadata } from '../src/app/[locale]/not-found';
import NotFoundPageView from '../src/components/pages/NotFoundPageView';
import { CATEGORY_WORDS, isCategoryWord } from '../src/lib/category-words';
import { routing } from '../src/i18n/routing';
import { FORMAT_NAME_ALIASES, isSameFormat } from '../src/lib/format-aliases';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { allElements, attrOf, headings, links, renderDom, select, visibleText } from './helpers/rendered-dom';
import type { TestLocale } from './helpers/intl';

/**
 * A path the site does not offer is answered 404 from the page, in English and under /ko, as the reference converter
 * answers it. The slug page and the catch-all page are the only places a path becomes a page, so each class of path is run
 * through the functions a request calls, and the parser the slug page asks is swept over the registry.
 */

const request = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ko', pathname: '/' }));

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
  getTranslations: async (arg: string | { locale: 'en' | 'ko'; namespace: string }) => {
    const { locale, namespace } = typeof arg === 'string' ? { locale: request.locale, namespace: arg } : arg;
    return (await import('./helpers/intl')).testTranslator(locale, namespace as 'slugPages');
  },
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => request.pathname,
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
  'a utility page of a format its operation does not run': [
    'merge-xyz', 'merge-docx', 'merge-jpg', 'merge-txt', 'compress-gif', 'compress-docx', 'compress-xyz', 'compress-png', 'compress-jpg', 'merge-', 'compress-',
  ],
  'a path that names a file': ['backup.zip', 'foo-to-bar.php', 'x.php-converter', 'zip-to-x.tar.gz', 'pdf-to-docx.php'],
  'a page name with a space, a tab, a line break or a slash around it': [
    'pdf-to-jpg ', ' pdf-to-jpg', '\tpdf-to-jpg', 'pdf-to-jpg\n', '\npdf-to-jpg\r', '/pdf-to-jpg', '//pdf-to-jpg', 'pdf-ocr ', ' terms', 'merge-pdf\t', 'pdf-converter ', ' video-converter',
  ],
};

const PAGE: Record<string, readonly string[]> = {
  'a registered pair the registry offers': ['jpg-to-pdf', 'png-to-jpg', 'pdf-to-docx', 'mp4-to-mp3', 'heic-to-jpg', 'csv-to-json', 'zip-to-tar.gz', 'tar.gz-to-zip', 'PDF-to-JPG'],
  'a format converted to itself or to its other name': ['jpeg-to-jpg', 'jfif-to-jpg', 'mp4-to-mp4', 'pdf-to-pdf', 'png-to-png', 'tif-to-tiff'],
  'the converter of a format or a category': ['pdf-converter', 'jpeg-converter', 'tar.gz-converter', 'video-converter', 'image-converter', 'document-converter', 'data-converter', 'Video-Converter'],
  'the OCR page': ['pdf-ocr'],
  'a utility page of a format its operation runs': ['merge-pdf', 'compress-pdf', 'save-website-as-pdf', 'website-png-screenshot', 'website-jpg-screenshot'],
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
          if (page !== 404 || metadata !== 404) wrong.push(`${locale} ${JSON.stringify(slug)}: page ${page}, metadata ${metadata}`);
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

  it('answers 404 from the catch-all page that a path of two or more segments under a locale reaches', async () => {
    expect(await statusOf(() => UnknownPathPage())).toBe(404);
  });

  it('answers 404 for a slug under a language the site does not have', async () => {
    expect(await pageStatus('xx', 'pdf-to-jpg')).toBe(404);
  });
});

describe('the parser reads a pair as a page exactly when the registry offers it', () => {
  const ids = Object.keys(FORMAT_REGISTRY);
  const offers = (source: string, target: string) =>
    !isCategoryWord(source) && !isCategoryWord(target) && FORMAT_REGISTRY[source].targetFormats.includes(target);
  const listedPairs = ids.flatMap((source) => FORMAT_REGISTRY[source].targetFormats.filter((target) => offers(source, target)).map((target) => [source, target] as const));

  it('finds a page for every conversion the registry lists between two format names, and for no other pair of format names', () => {
    const wrong: string[] = [];
    let pages = 0;
    for (const source of ids) {
      for (const target of ids) {
        const parsed = parseConverterSlug(`${source}-to-${target}`);
        if (parsed) pages++;
        if (Boolean(parsed) !== offers(source, target)) wrong.push(`${source}-to-${target}: ${parsed ? 'not offered, page' : 'offered, no page'}`);
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
    expect(pages).toBe(listedPairs.length);
  });

  it('reads a conversion between two names of one format as the page of its source, and every other conversion as a pair', () => {
    const aliasPairs = listedPairs.filter(([source, target]) => isSameFormat(source, target));
    expect(aliasPairs.length).toBeGreaterThan(Object.keys(FORMAT_NAME_ALIASES).length);
    for (const [source, target] of listedPairs) {
      const slug = `${source}-to-${target}`;
      const same = isSameFormat(source, target);
      expect(parseConverterSlug(slug), slug).toMatchObject(
        same
          ? { sourceFormat: source, targetFormat: 'any', canonicalPath: `/${source}-converter`, copy: { kind: 'format', name: { kind: 'format', id: source } } }
          : { sourceFormat: source, targetFormat: target, canonicalPath: `/${slug}`, copy: { kind: 'pair', src: source, tgt: target } }
      );
    }
    for (const slug of ['tar.bz-to-tar.bz2', 'tbz-to-tar.bz2', 'tar.bz2-to-tar.bz2', 'jpeg-to-jpg', 'jfif-to-jpg', 'tgz-to-tar.gz']) {
      expect(parseConverterSlug(slug)?.copy.kind, slug).toBe('format');
    }
  });

  it('finds the converter page of every registered format and of every category the registry has, and no other converter page', () => {
    const categories = new Set(Object.values(FORMAT_REGISTRY).map((definition) => definition.category));
    expect(Object.keys(CATEGORY_WORDS).sort()).toEqual([...categories].sort());
    for (const id of ids) expect(parseConverterSlug(`${id}-converter`), `${id}-converter`).toMatchObject({ canonicalPath: `/${id}-converter` });
    for (const word of categories) expect(parseConverterSlug(`${word}-converter`), `${word}-converter`).toMatchObject({ canonicalPath: `/${word}-converter` });
  });

  it('gives the format that is also a category word (presentation) no pair page and no page of its own but its converter page', () => {
    expect(isCategoryWord('presentation')).toBe(true);
    expect(Object.hasOwn(FORMAT_REGISTRY, 'presentation')).toBe(true);
    expect(parseConverterSlug('presentation-to-pdf')).toBeNull();
    expect(parseConverterSlug('pdf-to-presentation')).toBeNull();
    expect(parseConverterSlug('presentation-converter')).toMatchObject({ copy: { kind: 'format', name: { kind: 'category', id: 'presentation' } } });
  });

  it('names a registered source, and a registered target when there is one, for every page that is not an information page', () => {
    const slugs = [
      ...ids.map((id) => `${id}-converter`),
      ...Object.keys(CATEGORY_WORDS).map((word) => `${word}-converter`),
      ...listedPairs.map(([source, target]) => `${source}-to-${target}`),
      'pdf-ocr', 'merge-pdf', 'compress-pdf', 'save-website-as-pdf', 'website-png-screenshot', 'website-jpg-screenshot',
    ];
    const wrong: string[] = [];
    for (const slug of slugs) {
      const parsed = parseConverterSlug(slug);
      if (!parsed) wrong.push(`${slug}: no page`);
      else if (!parsed.isInfoPage && (!Object.hasOwn(FORMAT_REGISTRY, parsed.sourceFormat) || (parsed.targetFormat !== 'any' && !Object.hasOwn(FORMAT_REGISTRY, parsed.targetFormat)))) {
        wrong.push(`${slug}: ${parsed.sourceFormat} to ${parsed.targetFormat}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(slugs.length).toBeGreaterThan(2500);
  });

  it('keeps the lowercase path as the one canonical of a page named in capitals, and no other change to what was asked', () => {
    expect(parseConverterSlug('PDF-to-JPG')?.canonicalPath).toBe('/pdf-to-jpg');
    expect(parseConverterSlug('Video-Converter')?.canonicalPath).toBe('/video-converter');
    expect(parseConverterSlug('Zip-To-Tar.GZ')?.canonicalPath).toBe('/zip-to-tar.gz');
    expect(parseConverterSlug(' pdf-to-jpg')).toBeNull();
  });
});

describe('the page a path with no page shows', () => {
  const WORDING: Record<TestLocale, { code: string; title: (route: string) => string; description: string; home: string }> = {
    en: { code: '404', title: (route) => `The route ${route} could not be found.`, description: 'Sorry, the page you are looking for could not be found.', home: '/' },
    ko: { code: '페이지 없음', title: (route) => `${route} 경로를 찾을 수 없어요.`, description: '죄송해요, 찾으시는 페이지가 없어요.', home: '/ko' },
  };
  const render = (locale: TestLocale, pathname: string) => {
    request.pathname = pathname;
    return renderDom(createElement(NotFoundPageView), locale);
  };

  it.each(routing.locales)('shows in %s a thin header with the logo linked home alone, then a code, one heading that names the route and one sentence, and no footer', (locale) => {
    const page = render(locale, locale === 'en' ? '/nonexistent-page-xyz' : '/ko/nonexistent-page-xyz');
    const [header] = select(page, 'header');
    expect(links(header)).toEqual([{ text: 'EasyConvert', href: WORDING[locale].home }]);
    expect(allElements(header).filter((element) => ['nav', 'button'].includes(element.tagName))).toEqual([]);
    expect(links(page)).toHaveLength(1);
    const main = select(page, 'main')[0];
    expect(headings(main)).toEqual([WORDING[locale].title('nonexistent-page-xyz')]);
    expect(visibleText(main)).toBe(`${WORDING[locale].code} ${WORDING[locale].title('nonexistent-page-xyz')} ${WORDING[locale].description}`);
    expect(select(page, 'header')).toHaveLength(1);
    expect(select(page, 'footer')).toHaveLength(0);
  });

  it.each([
    ['en', '/foo/bar', 'foo/bar'],
    ['ko', '/ko/foo/bar', 'foo/bar'],
    ['en', '/pdf-to-jpg/extra', 'pdf-to-jpg/extra'],
    ['ko', '/ko/%ED%95%9C%EA%B8%80', '%ED%95%9C%EA%B8%80'],
  ] as const)('names the route of %s path %s as %s', (locale, pathname, route) => {
    const main = select(render(locale, pathname), 'main')[0];
    expect(headings(main)).toEqual([WORDING[locale].title(route)]);
  });

  it('keeps the skip link target of the layout', () => {
    expect(attrOf(select(render('en', '/x'), 'main')[0], 'id')).toBe('main-content');
  });

  it.each([
    ['en', 'Page not found | EasyConvert'],
    ['ko', '페이지를 찾을 수 없어요 | EasyConvert'],
  ] as const)('titles the page in %s as not found, not as the home page', async (locale, title) => {
    request.locale = locale;
    const metadata = await notFoundMetadata();
    expect(metadata.title).toBe(title);
    expect(metadata.description).toBe(WORDING[locale].description);
    expect(metadata.alternates).toBeUndefined();
  });
});
