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
import { LEGAL_DOCUMENTS, REFUND_POLICY_SECTION_ID, type LegalDocumentId } from '../src/lib/legal/documents';
import { LEGAL_TEXTS } from '../src/lib/legal/texts';
import { readLegalPage } from '../src/lib/legal/render';
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
const VERSION_DATE: Record<TestLocale, string> = { en: 'Effective December 13, 2026', ko: '시행일 2026년 12월 13일' };

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
    expect(attrOf(time, 'datetime')).toBe('2026-12-13');
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
    const known = [...Object.values(LEGAL_DOCUMENTS).map((doc) => doc.path), '/contact', '/pricing'];
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

describe('the terms state the free allowance and the paid plans', () => {
  it.each(LOCALES)('in %s', (locale) => {
    const text = visibleText(renderPage('terms', locale));
    expect(text).toContain(locale === 'en' ? 'you can run 10 conversions on our servers per day' : '하루에 서버 변환을 10회까지');
    expect(text).not.toContain(locale === 'en' ? 'Paid plans are not offered at present' : '현재 유료 요금제는 판매하지 않습니다');
  });

  it.each(LOCALES)('name the seller, the payment provider and the four paid sections, in the order of the other terms, in %s', (locale) => {
    const page = renderPage('terms', locale);
    const titles = select(page, 'h2').filter((heading) => attrOf(heading, 'id') !== 'legal-contents').map((heading) => visibleText(heading));
    const sections = locale === 'en' ? ['5. Paid plans and billing', '6. Cancellation', '7. Refunds', '8. Price changes'] : ['5. 유료 요금제와 결제', '6. 해지', '7. 환불', '8. 가격 변경'];
    expect(titles.slice(4, 8)).toEqual(sections);
    const text = visibleText(page);
    expect(text).toContain(locale === 'en' ? 'Dongin Jeong, a sole proprietor' : '개인사업자 정동인(이하');
    expect(text).toContain('Paddle.com');
    expect(text).toContain(locale === 'en' ? 'merchant of record' : 'Merchant of Record');
  });
});

describe('the payment provider in the other legal texts', () => {
  it.each(LOCALES)('is named in the privacy policy as an independent controller, with its notice, and in the processing terms as no subprocessor, in %s', (locale) => {
    const privacy = visibleText(renderPage('privacy', locale));
    const dpa = visibleText(renderPage('dpa', locale));
    expect(privacy).toContain('Paddle.com Market Limited');
    expect(privacy).toContain(locale === 'en' ? 'independent controller' : '독립적인 개인정보처리자');
    expect(links(renderPage('privacy', locale)).map((link) => link.href)).toContain('https://www.paddle.com/legal/privacy');
    expect(dpa).toContain(locale === 'en' ? 'is not a subprocessor' : '재수탁자가 아닙니다');
  });
});

describe('the legal texts', () => {
  it('refuse a text without a title, an introduction or a section, instead of rendering an empty page', () => {
    expect(() => readLegalPage('Only a paragraph.', 'en')).toThrow(/title/);
    expect(() => readLegalPage('# Title\n\nAn introduction and no section.', 'en')).toThrow(/section/);
    expect(() => readLegalPage('# Title\n\n## 1. One\n\nNo intro.', 'en')).toThrow(/introductory paragraph/);
    expect(readLegalPage('# Title\n\nIntro.\n\n## 1. One\n\nSee the [contact page](/contact).', 'ko').bodyHtml).toContain('href="/ko/contact"');
  });

  it('are the Markdown files of docs/legal, one per page and language', () => {
    for (const [id, locale] of CASES) {
      const file = path.join(rootDir, 'docs', 'legal', `${LEGAL_DOCUMENTS[id].path.slice(1)}.${locale}.md`);
      expect(LEGAL_TEXTS[id][locale], file).toBe(fs.readFileSync(file, 'utf8'));
    }
  });
});

function importsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1].replace(/\?raw$/, ''));
  return specifiers.flatMap((specifier) => {
    const base = specifier.startsWith('@/') ? path.join(rootDir, 'src', specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : undefined;
    if (!base) return [];
    const found = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    return found ? [found] : [];
  });
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  for (const file of seen) for (const imported of importsOf(file)) seen.add(imported);
  return seen;
}

describe('the client bundles', () => {
  it('reach no legal text: no client component imports the texts, the renderer or the legal components, directly or not', () => {
    const sources = fs.readdirSync(path.join(rootDir, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(rootDir, 'src', name));
    const clientEntries = sources.filter((file) => /^\s*['"]use client['"]/.test(fs.readFileSync(file, 'utf8')));
    const legalOnly = [path.join(rootDir, 'src', 'lib', 'legal', 'texts.ts'), path.join(rootDir, 'src', 'lib', 'legal', 'render.ts')];
    expect(clientEntries.length).toBeGreaterThan(20);
    expect(reachableFrom(path.join(rootDir, 'src', 'app', '[locale]', 'terms', 'page.tsx')).has(legalOnly[0])).toBe(true);
    const leaks = clientEntries.filter((entry) => {
      const reached = reachableFrom(entry);
      return legalOnly.some((file) => reached.has(file)) || [...reached].some((file) => file.startsWith(path.join(rootDir, 'docs', 'legal')));
    });
    expect(leaks.map((file) => path.relative(rootDir, file))).toEqual([]);
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

describe('the refund policy', () => {
  it.each(LOCALES)('is the section of the terms the footer links to in %s, by an anchor that heading has', (locale) => {
    const anchor = REFUND_POLICY_SECTION_ID[locale];
    const sectionIds = select(renderPage('terms', locale), 'h2').map((heading) => attrOf(heading, 'id'));
    expect(sectionIds).toContain(anchor);
    const prefix = locale === 'en' ? '' : `/${locale}`;
    const refundLinks = select(renderDom(createElement(Footer), locale), 'a').filter((a) => decodeURIComponent(attrOf(a, 'href') ?? '') === `${prefix}/terms#${anchor}`);
    expect(refundLinks.map((a) => visibleText(a))).toEqual([locale === 'en' ? 'Refund policy' : '환불 정책']);
  });

  it.each(LOCALES)('states that payments are non-refundable except where the law requires, and that refunds go through Paddle, in %s', (locale) => {
    const text = visibleText(renderPage('terms', locale));
    expect(text).toContain(locale === 'en' ? 'non-refundable, except where the law requires otherwise' : '환불하지 않습니다. 다만 청약철회권처럼 법령이 환불을 요구하는 경우는 예외입니다');
    expect(text).toContain(locale === 'en' ? 'Refund requests go through Paddle' : '환불은 Paddle을 통해 요청하며');
  });
});

describe('the footer', () => {
  it.each(LOCALES)('links to every legal page in %s and sets none of them out in bold', (locale) => {
    const footer = renderDom(createElement(Footer), locale);
    const prefix = locale === 'en' ? '' : `/${locale}`;
    const hrefs = links(footer).map((link) => link.href);
    for (const { path: pathname } of Object.values(LEGAL_DOCUMENTS)) expect(hrefs).toContain(`${prefix}${pathname}`);
    const legal = Object.values(LEGAL_DOCUMENTS).flatMap(({ path: pathname }) => select(footer, 'a', 'href', `${prefix}${pathname}`));
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.some((a) => classTokens(a).has('font-bold'))).toBe(false);
  });
});
