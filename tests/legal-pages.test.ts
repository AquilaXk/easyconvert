import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { LegalDocument } from '../src/components/legal/LegalDocument';
import Footer from '../src/components/Footer';
import * as termsRoute from '../src/app/[locale]/terms/page';
import * as privacyRoute from '../src/app/[locale]/privacy/page';
import * as dpaRoute from '../src/app/[locale]/dpa/page';
import * as acceptableUseRoute from '../src/app/[locale]/acceptable-use/page';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from '../src/lib/legal/documents';
import { LEGAL_TEXTS } from '../src/lib/legal/texts';
import { allElements, attrOf, classTokens, headings, links, renderDom, select, visibleText } from './helpers/rendered-dom';
import type { TestLocale } from './helpers/intl';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The legal pages of issue #901 as a visitor reads them: each page in each language names its version date above its
 * title, has a table of contents whose links land on its sections, and links only to pages that exist. The footer links to
 * all four, the privacy policy set out from the rest as the drafting guideline of the privacy regulator asks.
 */

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
  getTranslations: async ({ locale, namespace }: { locale: TestLocale; namespace: 'meta.legal' }) =>
    (await import('./helpers/intl')).testTranslator(locale, namespace),
}));

const rootDir = path.resolve(__dirname, '..');
const DOCUMENTS = Object.keys(LEGAL_DOCUMENTS) as LegalDocumentId[];
const LOCALES: readonly TestLocale[] = ['en', 'ko'];
const CASES = DOCUMENTS.flatMap((id) => LOCALES.map((locale) => [id, locale] as const));

/** The version date as each language writes it, typed out from the requirement rather than from the formatter. */
const VERSION_DATE: Record<TestLocale, string> = { en: 'Effective November 3, 2026', ko: '시행일 2026년 11월 3일' };

const TITLES: Record<LegalDocumentId, Record<TestLocale, string>> = {
  terms: { en: 'Terms of Service', ko: '이용약관' },
  privacy: { en: 'Privacy Policy', ko: '개인정보 처리방침' },
  dpa: { en: 'Data Processing Terms', ko: '개인정보 처리위탁 약관' },
  acceptableUse: { en: 'Acceptable Use Policy', ko: '이용 제한 정책' },
};

/** The route module of each page path, imported from the folder of that path. */
const ROUTES: Record<string, typeof termsRoute> = {
  '/terms': termsRoute,
  '/privacy': privacyRoute,
  '/dpa': dpaRoute,
  '/acceptable-use': acceptableUseRoute,
};

const renderPage = (id: LegalDocumentId, locale: TestLocale) => renderDom(createElement(LegalDocument, { id, locale }), locale);

describe('each legal page in each language', () => {
  it.each(CASES)('%s in %s names its version date above its title', (id, locale) => {
    const page = renderPage(id, locale);
    const [time] = select(page, 'time');
    expect(attrOf(time, 'datetime')).toBe('2026-11-03');
    expect(visibleText(time)).toBe(VERSION_DATE[locale]);
    expect(headings(page)[0]).toBe(TITLES[id][locale]);
  });

  it.each(CASES)('%s in %s lists every section in its contents, each link landing on its section', (id, locale) => {
    const page = renderPage(id, locale);
    const [contents] = select(page, 'nav');
    const targets = links(contents).map((link) => link.href);
    const ids = new Set(allElements(page).map((element) => attrOf(element, 'id')));
    const sectionHeadings = select(page, 'h2').filter((heading) => attrOf(heading, 'id') !== 'legal-contents');
    expect(targets.length).toBeGreaterThan(3);
    expect(targets).toEqual(sectionHeadings.map((heading) => `#${attrOf(heading, 'id')}`));
    expect(targets.filter((href) => !ids.has(href.slice(1)))).toEqual([]);
  });

  it.each(CASES)('%s in %s links only to pages of the site in its own language', (id, locale) => {
    const known = [...Object.values(LEGAL_DOCUMENTS).map((doc) => doc.path), '/contact'];
    const expected = new Set(known.map((pathname) => (locale === 'en' ? pathname : `/${locale}${pathname}`)));
    const inSite = links(renderPage(id, locale))
      .map((link) => link.href)
      .filter((href) => href.startsWith('/'));
    expect(inSite.filter((href) => !expected.has(href))).toEqual([]);
  });

  it.each(CASES)('%s in %s has a route at its path whose canonical is that path', async (id, locale) => {
    const { path: pathname } = LEGAL_DOCUMENTS[id];
    const metadata = await ROUTES[pathname].generateMetadata({ params: Promise.resolve({ locale }) });
    expect(metadata.title).toBe(`${TITLES[id][locale]} | EasyConvert`);
    expect(String(metadata.description).length).toBeGreaterThan(40);
    expect(metadata.alternates?.canonical).toBe(locale === 'en' ? pathname : `/${locale}${pathname}`);
  });
});

describe('the terms state the free allowance and no paid plan', () => {
  it.each(LOCALES)('in %s', (locale) => {
    const text = visibleText(renderPage('terms', locale));
    expect(text).toContain(locale === 'en' ? 'you can run 10 conversions on our servers per day' : '하루에 서버 변환을 10회까지');
    expect(text).toContain(locale === 'en' ? 'Paid plans are not offered at present' : '현재 유료 요금제는 판매하지 않습니다');
  });
});

describe('the legal texts', () => {
  it('are the Markdown files of docs/legal, one per page and language', () => {
    for (const [id, locale] of CASES) {
      const file = path.join(rootDir, 'docs', 'legal', `${LEGAL_DOCUMENTS[id].path.slice(1)}.${locale}.md`);
      expect(LEGAL_TEXTS[id][locale], file).toBe(fs.readFileSync(file, 'utf8'));
    }
  });
});

describe('the web image', () => {
  it('copies every file the legal texts import into the build stage before it builds the app', () => {
    const texts = fs.readFileSync(path.join(rootDir, 'src', 'lib', 'legal', 'texts.ts'), 'utf8');
    const imported = [...texts.matchAll(/from '\.\.\/\.\.\/\.\.\/([^']+)\?raw'/g)].map((match) => match[1]);
    const [builder] = parseDockerfile(fs.readFileSync(path.join(rootDir, 'Dockerfile.web'), 'utf8')).filter((stage) => stage.name === 'webbuilder');
    const build = builder.instructions.find((step) => step.keyword === 'RUN' && step.argument.includes('next build'));
    const copied = builder.instructions
      .filter((step) => step.keyword === 'COPY' && step.index < (build?.index ?? -1))
      .map((step) => step.argument.split(/\s+/)[0]);
    expect(imported).toHaveLength(8);
    expect(imported.filter((file) => !copied.some((source) => file.startsWith(source)))).toEqual([]);
  });
});

describe('the footer', () => {
  it.each(LOCALES)('links to every legal page in %s and sets the privacy policy out in bold', (locale) => {
    const footer = renderDom(createElement(Footer), locale);
    const prefix = locale === 'en' ? '' : `/${locale}`;
    const hrefs = links(footer).map((link) => link.href);
    for (const { path: pathname } of Object.values(LEGAL_DOCUMENTS)) expect(hrefs).toContain(`${prefix}${pathname}`);
    const privacy = select(footer, 'a', 'href', `${prefix}/privacy`);
    const terms = select(footer, 'a', 'href', `${prefix}/terms`);
    expect(privacy.length).toBeGreaterThan(0);
    expect(privacy.every((a) => classTokens(a).has('font-bold'))).toBe(true);
    expect(terms.some((a) => classTokens(a).has('font-bold'))).toBe(false);
  });
});
