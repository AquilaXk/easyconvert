import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { config, middleware } from '../src/middleware';
import { localeAlternates } from '../src/i18n/metadata';
import { routing } from '../src/i18n/routing';
import { FORMAT_REGISTRY } from '../src/lib/registry';

/**
 * Locale routing as a visitor meets it: English at the unprefixed paths, Korean under /ko, the visitor's language
 * negotiated on the root only, and API routes untouched. The middleware runs on real requests; the matcher is compiled
 * with the function Next.js compiles it with.
 */

const ORIGIN = 'http://localhost:3000';

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

  it('routes converter slugs whose format holds a dot in every language', async () => {
    expect(DOTTED_SLUGS).toContain('/zip-to-tar.gz');
    for (const slug of DOTTED_SLUGS) {
      expect(matched(slug), slug).toBe(true);
      expect(matched(`/ko${slug}`), `/ko${slug}`).toBe(true);
    }
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
    for (const headers of [{}, KOREAN_BROWSER, { cookie: 'NEXT_LOCALE=ko' }, { cookie: 'NEXT_LOCALE=en' }]) {
      const root = await answer('/', headers);
      expect(root.vary, JSON.stringify(headers)).toBe('Accept-Language, Cookie');
      expect(root.cacheControl, JSON.stringify(headers)).toBe('private, no-store');
    }
    expect((await answer('/status')).cacheControl).toBeNull();
  });

  it('writes the locale cookie only from the language selector, never while negotiating the root', async () => {
    for (const headers of [{}, KOREAN_BROWSER, { 'accept-language': 'fr-FR' }, { cookie: 'NEXT_LOCALE=ko' }]) {
      const res = await middleware(request('/', headers));
      expect(res.headers.get('set-cookie'), JSON.stringify(headers)).toBeNull();
      expect(res.headers.get('x-middleware-set-cookie'), JSON.stringify(headers)).toBeNull();
    }
  });

  it('names the page in every language in a Link header', async () => {
    const { link } = await answer('/ko/png-to-jpg');
    expect(link).toContain(`<${ORIGIN}/png-to-jpg>; rel="alternate"; hreflang="en"`);
    expect(link).toContain(`<${ORIGIN}/ko/png-to-jpg>; rel="alternate"; hreflang="ko"`);
    expect(link).toContain(`<${ORIGIN}/png-to-jpg>; rel="alternate"; hreflang="x-default"`);
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
