import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import Footer from '../src/components/Footer';
import Header from '../src/components/Header';
import { POPULAR_PAIRS_BY_CATEGORY } from '../src/components/Features';
import ConverterPageView from '../src/components/pages/ConverterPageView';
import HomePageView from '../src/components/pages/HomePageView';
import { FOOTER_COLUMNS, PRIMARY_LINKS, TOOL_ROUTES, type SiteLink } from '../src/components/site-links';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { CATEGORY_WORDS } from '../src/lib/category-words';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { parsedSlug } from './helpers/intl';
import { links, renderDom, type DomElement } from './helpers/rendered-dom';
import type { TestLocale } from './helpers/intl-messages';

/**
 * Every link the site renders to one of its own pages leads to a page that exists: a route of its own under src/app/[locale]
 * or a slug the parser reads as a page. The links of the site chrome, the home page and the converter pages are read from
 * what a visitor receives, and the tables that feed the home page (the directory) are
 * read as data, since a render shows one state of each.
 */

const APP_ROUTES_ROOT = path.resolve(__dirname, '..', 'src', 'app', '[locale]');
const ROUTES = new Set([
  '/',
  ...fs.readdirSync(APP_ROUTES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('['))
    .filter((entry) => fs.existsSync(path.join(APP_ROUTES_ROOT, entry.name, 'page.tsx')))
    .map((entry) => `/${entry.name}`),
]);

/** The path a link leads to inside the site, without its language prefix, query and hash; null for a link that leaves it. */
function sitePath(href: string): string | null {
  if (!href.startsWith('/')) return null;
  const [pathname] = href.split(/[?#]/);
  const unprefixed = pathname.replace(/^\/ko(?=\/|$)/, '') || '/';
  return unprefixed.startsWith('/api/') || unprefixed === '/api' ? null : unprefixed;
}

const hasPage = (pathname: string): boolean => ROUTES.has(pathname) || parseConverterSlug(pathname.slice(1)) !== null;

const hrefOf = (link: SiteLink): string => (typeof link.href === 'string' ? link.href : (link.href.pathname ?? '/'));

/** The links among `hrefs` that lead nowhere. */
const deadLinks = (hrefs: readonly string[]): string[] =>
  [...new Set(hrefs)].filter((href) => {
    const pathname = sitePath(href);
    return pathname !== null && !hasPage(pathname);
  });

const hrefsOf = (root: DomElement) => links(root).map((link) => link.href);
const render = (element: Parameters<typeof renderDom>[0], locale: TestLocale) => hrefsOf(renderDom(element, locale));
const LOCALES: readonly TestLocale[] = ['en', 'ko'];

describe('the links the site renders lead to pages that exist', () => {
  it('finds the routes of the app that are not slug pages, and none for the retired status and unit converter pages', () => {
    expect(ROUTES.has('/status') || ROUTES.has('/unit-converter')).toBe(false);
    expect([...ROUTES].sort()).toEqual(expect.arrayContaining(['/', '/api-docs', '/dashboard']));
  });

  it('holds for every link of the site chrome tables', () => {
    const footer: SiteLink[] = FOOTER_COLUMNS.flatMap((column) => [...column.links]);
    const table: SiteLink[] = [...TOOL_ROUTES, ...PRIMARY_LINKS, ...footer];
    expect(table.length).toBeGreaterThan(15);
    expect(deadLinks(table.map(hrefOf))).toEqual([]);
  });

  it('holds for the common conversion types of the home page directory', () => {
    const pairs = Object.values(POPULAR_PAIRS_BY_CATEGORY).flat();
    expect(pairs.length).toBeGreaterThan(30);
    expect(deadLinks(pairs.map(({ from, to }) => `/${from}-to-${to}`))).toEqual([]);
  });

  it.each(LOCALES)('holds for the header, the footer and the home page in %s', (locale) => {
    expect(deadLinks([...render(createElement(Header), locale), ...render(createElement(Footer), locale)])).toEqual([]);
    const home = render(createElement(HomePageView, { dailyLimit: ANONYMOUS_DAILY_CONVERSIONS, apiOrigin: 'https://convert.example.test' }), locale);
    expect(home.length).toBeGreaterThan(50);
    expect(deadLinks(home)).toEqual([]);
  });

  it.each(LOCALES)('holds for the page of every registered format and every category in %s, which hold the lists of related conversions', (locale) => {
    const slugs = [...Object.keys(FORMAT_REGISTRY), ...Object.keys(CATEGORY_WORDS)].map((word) => `${word}-converter`);
    const dead: string[] = [];
    let checked = 0;
    for (const slug of slugs) {
      const hrefs = render(createElement(ConverterPageView, { parsed: parsedSlug(slug), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }), locale);
      checked += hrefs.length;
      dead.push(...deadLinks(hrefs).map((href) => `/${slug} links ${href}`));
    }
    expect(checked).toBeGreaterThan(slugs.length * 20);
    expect(dead).toEqual([]);
  }, 120_000);

  it.each(LOCALES)('holds for pair pages, utility pages and site pages in %s', (locale) => {
    const slugs = ['png-to-jpg', 'pdf-to-docx', 'mp4-to-gif', 'jpeg-to-jpg', 'zip-to-tar.gz', 'merge-pdf', 'compress-pdf', 'compress-png', 'compress-jpg', 'save-website-as-pdf', 'website-png-screenshot', 'pdf-ocr', 'contact', 'about', 'accessibility'];
    const dead = slugs.flatMap((slug) =>
      deadLinks(render(createElement(ConverterPageView, { parsed: parsedSlug(slug), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }), locale)).map((href) => `/${slug} links ${href}`)
    );
    expect(dead).toEqual([]);
  });

  it('would find a link to a pair the site does not offer, or to the retired status page', () => {
    expect(deadLinks(['/video-to-mp4', '/ko/image-to-pdf', '/ocr', '/foo-converter', '/mp4-to-gif', '/ko/video-converter', '/status', '/#format-catalog'])).toEqual([
      '/video-to-mp4',
      '/ko/image-to-pdf',
      '/ocr',
      '/foo-converter',
      '/status',
    ]);
  });
});
