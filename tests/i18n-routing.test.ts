import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { getAccessFallbackHTTPStatus, isHTTPAccessFallbackError } from 'next/dist/client/components/http-access-fallback/http-access-fallback';
import ConverterPage, { generateMetadata } from '../src/app/[locale]/[slug]/page';
import { config, middleware } from '../src/middleware';
import { localeAlternates } from '../src/i18n/metadata';
import { routing } from '../src/i18n/routing';
import { FORMAT_NAME_ALIASES } from '../src/lib/format-aliases';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { DOTTED_FORMAT_SUFFIXES, canonicalSlugPath, parseConverterSlug } from '../src/lib/slug-parser';
import { parsedSlug } from './helpers/intl';

/**
 * Locale routing as a visitor meets it: English at the unprefixed paths, Korean under /ko, the visitor's language
 * negotiated on the root only, and API routes untouched. The middleware runs on real requests; the matcher is compiled
 * with the function Next.js compiles it with.
 */

const ORIGIN = 'http://localhost:3000';

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
  // The metadata reads its titles from the messages of the locale, as the page's translator would.
  getTranslations: async ({ locale, namespace }: { locale: 'en' | 'ko'; namespace: 'slugPages' | 'meta.converter' }) =>
    (await import('./helpers/intl')).testTranslator(locale, namespace),
}));

function request(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${pathname}`, { headers });
}

async function answer(pathname: string, headers: Record<string, string> = {}) {
  const res = await middleware(request(pathname, headers));
  return {
    status: res.status,
    location: res.headers.get('location'),
    rewrite: res.headers.get('x-middleware-rewrite'),
    setCookie: res.headers.get('set-cookie'),
    link: res.headers.get('link'),
    vary: res.headers.get('vary'),
    cacheControl: res.headers.get('cache-control'),
  };
}

const KOREAN_BROWSER = { 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.5' };

const matchers = config.matcher.map((source) => new RegExp(tryToParsePath(source).regexStr!));
const matched = (pathname: string) => matchers.some((matcher) => matcher.test(pathname));

/** Every file under public/, as the path a browser asks for. */
function publicPaths(): string[] {
  const root = path.resolve(__dirname, '..', 'public');
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')}`);
}

/** Converter slugs whose format id holds a dot (`tar.gz`), in both directions. */
const DOTTED_SLUGS = Object.values(FORMAT_REGISTRY)
  .filter((format) => format.id.includes('.'))
  .flatMap((format) => [`/zip-to-${format.id}`, `/${format.id}-to-zip`]);

describe('locale routing of pages', () => {
  it('serves English at the unprefixed paths, the home page included', async () => {
    expect((await answer('/')).rewrite).toBe(`${ORIGIN}/en`);
    expect((await answer('/png-to-jpg')).rewrite).toBe(`${ORIGIN}/en/png-to-jpg`);
    expect((await answer('/api-docs')).rewrite).toBe(`${ORIGIN}/en/api-docs`);
  });

  it('serves Korean under /ko', async () => {
    const home = await answer('/ko');
    expect(home.rewrite ?? null).toBeNull();
    expect(home.status).toBe(200);
    expect((await answer('/ko/png-to-jpg')).status).toBe(200);
  });

  it('sends a superfluous /en prefix to the unprefixed URL', async () => {
    expect(await answer('/en/status')).toMatchObject({ status: 307, location: `${ORIGIN}/status` });
  });

  it('routes converter slugs whose format holds a dot in every language, however they are cased', async () => {
    expect(DOTTED_SLUGS).toContain('/zip-to-tar.gz');
    for (const slug of DOTTED_SLUGS.flatMap((slug) => [slug, slug.toUpperCase()])) {
      expect(matched(slug), slug).toBe(true);
      expect(matched(`/ko${slug}`), `/ko${slug}`).toBe(true);
    }
    for (const slug of ['/zip-to-TAR.GZ', '/TAR.GZ-to-zip', '/ko/Zip-To-Tar.GZ', '/ko/Tar.Xz-to-zip']) expect(matched(slug), slug).toBe(true);
    expect((await answer('/zip-to-tar.gz')).rewrite).toBe(`${ORIGIN}/en/zip-to-tar.gz`);
    expect((await answer('/tar.gz-to-zip')).rewrite).toBe(`${ORIGIN}/en/tar.gz-to-zip`);
    expect((await answer('/ko/zip-to-tar.gz')).status).toBe(200);
    expect(await answer('/en/zip-to-tar.gz')).toMatchObject({ status: 307, location: `${ORIGIN}/zip-to-tar.gz` });
  });

  it('negotiates the language from Accept-Language on the root only', async () => {
    expect(await answer('/', KOREAN_BROWSER)).toMatchObject({ status: 307, location: `${ORIGIN}/ko` });
    const shared = await answer('/png-to-jpg', KOREAN_BROWSER);
    expect(shared.location).toBeNull();
    expect(shared.rewrite).toBe(`${ORIGIN}/en/png-to-jpg`);
  });

  it('follows a chosen language on the root, and writes no cookie on any other page', async () => {
    expect(await answer('/', { cookie: 'NEXT_LOCALE=ko' })).toMatchObject({ status: 307, location: `${ORIGIN}/ko` });
    expect((await answer('/', { ...KOREAN_BROWSER, cookie: 'NEXT_LOCALE=en' })).location).toBeNull();
    expect((await answer('/ko/status', { cookie: 'NEXT_LOCALE=en' })).setCookie).toBeNull();
    expect((await answer('/status', { cookie: 'NEXT_LOCALE=ko' })).setCookie).toBeNull();
  });

  it('answers the root privately and by language and cookie, so no shared cache hands one visitor another language', async () => {
    for (const headers of [{}, KOREAN_BROWSER, { cookie: 'NEXT_LOCALE=ko' }, { cookie: 'NEXT_LOCALE=en' }] as Array<Record<string, string>>) {
      const root = await answer('/', headers);
      expect(root.vary, JSON.stringify(headers)).toBe('Accept-Language, Cookie');
      expect(root.cacheControl, JSON.stringify(headers)).toBe('private, no-store');
    }
    expect((await answer('/status')).cacheControl).toBeNull();
  });

  it('writes the locale cookie only from the language selector, never while negotiating the root', async () => {
    for (const headers of [{}, KOREAN_BROWSER, { 'accept-language': 'fr-FR' }, { cookie: 'NEXT_LOCALE=ko' }] as Array<Record<string, string>>) {
      const res = await middleware(request('/', headers));
      expect(res.headers.get('set-cookie'), JSON.stringify(headers)).toBeNull();
      expect(res.headers.get('x-middleware-set-cookie'), JSON.stringify(headers)).toBeNull();
    }
  });

  it('sends no Link header, so the alternates are only the absolute ones of the page metadata', async () => {
    for (const pathname of ['/ko/png-to-jpg', '/png-to-jpg', '/ko/PNG-to-JPG', '/', '/ko']) {
      expect((await answer(pathname)).link, pathname).toBeNull();
    }
  });
});

describe('API routes are not locale routed', () => {
  it('answers an API request without a locale rewrite or redirect', async () => {
    const health = await answer('/api/health');
    expect(health.rewrite ?? null).toBeNull();
    expect(health.location).toBeNull();
    expect(health.link).toBeNull();
  });

  it('keeps the API body limits in front of the routes', async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/api/convert`, { method: 'POST', headers: { 'content-length': 'not-a-number' } })
    );
    expect(res.status).toBe(400);
  });

  it('answers 404 for an API path under a locale prefix instead of routing it as a page', async () => {
    for (const pathname of ['/ko/api/health', '/en/api/v1/jobs', '/ko/api']) {
      expect(matched(pathname), pathname).toBe(true);
      const res = await answer(pathname);
      expect(res, pathname).toMatchObject({ status: 404, location: null, link: null });
      expect(res.rewrite ?? null, pathname).toBeNull();
    }
    expect((await answer('/ko/api-docs')).status).toBe(200);
  });

  it('matches API paths and page paths, never framework files or static assets', () => {
    for (const pathname of ['/', '/ko', '/png-to-jpg', '/ko/png-to-jpg', '/api-docs', '/ko/api-docs', '/api/health', '/api/v1/jobs']) {
      expect(matched(pathname), pathname).toBe(true);
    }
    const assets = ['/_next/static/chunks/main.js', '/_vercel/insights', '/.well-known/security.txt', '/favicon.ico'];
    for (const pathname of [...assets, ...publicPaths()]) {
      expect(matched(pathname), pathname).toBe(false);
    }
  });

  it('leaves every other path with a dot to the file routes, so a probe for a file never renders a page', () => {
    const probes = [
      '/wp-login.php', '/.env', '/.git/config', '/xmlrpc.php', '/backup.zip', '/backup.tar.gz', '/index.html', '/a.JS',
      '/robots.TXT', '/ko/wp-login.php', '/ko/backup.zip', '/zip-to-tar.gzip', '/zip-to-tar.gz.php', '/zip-to-x.tar.gz',
      '/ko/.env', '/ZIP-to-TAR.GZIP', '/ko/zip-to-TAR.GZ.PHP',
    ];
    for (const pathname of probes) expect(matched(pathname), pathname).toBe(false);
  });
});

describe('page metadata names every language', () => {
  it('gives each locale its canonical URL and every locale as an alternate, English as x-default', () => {
    expect(routing.locales).toEqual(['en', 'ko']);
    expect(localeAlternates('ko', '/png-to-jpg')).toEqual({
      canonical: '/ko/png-to-jpg',
      languages: { en: '/png-to-jpg', ko: '/ko/png-to-jpg', 'x-default': '/png-to-jpg' },
    });
    expect(localeAlternates('en', '/')).toEqual({
      canonical: '/',
      languages: { en: '/', ko: '/ko', 'x-default': '/' },
    });
  });
});

describe('converter slug pages name one canonical URL', () => {
  it('names the lowercased slug as the canonical path', () => {
    for (const [slug, canonical] of [['PNG-to-JPG', '/png-to-jpg'], ['Zip-To-Tar.GZ', '/zip-to-tar.gz'], ['png-to-jpg', '/png-to-jpg']]) {
      expect(canonicalSlugPath(slug, parsedSlug(slug))).toBe(canonical);
    }
  });

  it.each([
    ['en', 'jpeg-to-jpg', '/jpeg-converter', '/ko/jpeg-converter'],
    ['ko', 'jpeg-to-jpg', '/ko/jpeg-converter', '/jpeg-converter'],
    ['en', 'pdf-to-pdf', '/pdf-converter', '/ko/pdf-converter'],
    ['ko', 'pdf-to-pdf', '/ko/pdf-converter', '/pdf-converter'],
    ['en', 'Jfif-To-JPG', '/jfif-converter', '/ko/jfif-converter'],
    ['ko', 'png-to-jpg', '/ko/png-to-jpg', '/png-to-jpg'],
    ['en', 'Video-Converter', '/video-converter', '/ko/video-converter'],
    ['en', 'pdf-ocr', '/pdf-ocr', '/ko/pdf-ocr'],
  ])('names the page of the parsed format as the canonical of %s %s, and the other locale as its alternate', async (locale, slug, canonical, other) => {
    const { alternates } = await generateMetadata({ params: Promise.resolve({ locale, slug }) });
    const [english, korean] = locale === 'en' ? [canonical, other] : [other, canonical];
    expect(alternates).toEqual({ canonical, languages: { en: english, ko: korean, 'x-default': english } });
  });

  // The slugs the parser reads as the page of their source: two names of one format that the registry lists a conversion
  // between, and a registry format converted to itself. Each starts with the word whose page it is.
  const aliasSlugs = Object.entries(FORMAT_NAME_ALIASES)
    .flatMap(([alias, format]) => [`${alias}-to-${format}`, `${format}-to-${alias}`])
    .filter((slug) => parseConverterSlug(slug));
  const selfTargetSlugs = Object.entries(FORMAT_REGISTRY)
    .filter(([id, { targetFormats }]) => targetFormats.includes(id))
    .map(([id]) => `${id}-to-${id}`);

  it('sweeps every slug read as the page of its source and finds it a copy of a page that is its own canonical', async () => {
    const swept = [...aliasSlugs, ...selfTargetSlugs];
    expect(aliasSlugs.length).toBeGreaterThan(10);
    expect(selfTargetSlugs.length).toBeGreaterThan(60);
    const metadataOf = (locale: string, slug: string) => generateMetadata({ params: Promise.resolve({ locale, slug }) });
    const broken: string[] = [];
    for (const slug of swept) {
      const canonical = `/${slug.split('-to-')[0]}-converter`;
      const [page, canonicalPage] = [parseConverterSlug(slug), parseConverterSlug(canonical)];
      if (!page || !canonicalPage || canonicalSlugPath(slug, page) !== canonical || canonicalSlugPath(canonical, canonicalPage) !== canonical) {
        broken.push(`${slug}: canonical ${page && canonicalSlugPath(slug, page)}`);
        continue;
      }
      for (const locale of routing.locales) {
        const [copy, page] = await Promise.all([metadataOf(locale, slug), metadataOf(locale, canonical.slice(1))]);
        if (copy.title !== page.title || JSON.stringify(copy.alternates) !== JSON.stringify(page.alternates) || copy.robots !== undefined) {
          broken.push(`${locale} ${slug}: differs from ${canonical}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('answers 404 from the page for a dotted path that reached it under a locale, and renders a dotted format id', async () => {
    const statusOf = async (locale: string, slug: string) => {
      try {
        await ConverterPage({ params: Promise.resolve({ locale, slug }) });
        return 200;
      } catch (error) {
        if (isHTTPAccessFallbackError(error)) return getAccessFallbackHTTPStatus(error);
        throw error;
      }
    };
    for (const [locale, slug] of [['ko', 'foo-to-bar.php'], ['ko', 'x.php-converter'], ['en', 'foo-to-bar.php'], ['ko', 'backup.zip']]) {
      expect(await statusOf(locale, slug), `/${locale}/${slug}`).toBe(404);
    }
    for (const slug of ['zip-to-tar.gz', 'Zip-To-Tar.GZ']) expect(await statusOf('ko', slug), `/ko/${slug}`).toBe(200);
  });

  it('allows in the middleware matcher exactly the dotted ids of the registry, in any case', () => {
    const dottedIds = Object.keys(FORMAT_REGISTRY).filter((id) => id.includes('.'));
    expect(dottedIds.map((id) => id.split('.')[0])).toEqual(dottedIds.map(() => 'tar'));
    expect([...DOTTED_FORMAT_SUFFIXES].sort()).toEqual(dottedIds.map((id) => id.slice('tar.'.length)).sort());
    const anyCase = (text: string) => text.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
    const suffixes = [...DOTTED_FORMAT_SUFFIXES].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(anyCase).join('|');
    expect(config.matcher[1]).toBe(
      `/((?!api(?:/|$)|_next/|_vercel/|fonts/|.*(?:(?<![/-]${anyCase('tar')})\\.|\\.(?!(?:${suffixes})(?:-|$)))).*)`
    );
  });
});
