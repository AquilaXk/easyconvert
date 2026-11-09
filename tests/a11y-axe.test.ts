// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testMessages, type TestLocale } from './helpers/intl-messages';
import { parsedSlug } from './helpers/intl';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';
import type { ConversionQueueItem } from '../src/lib/types';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => Promise.resolve() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

const { default: HomePageView } = await import('../src/components/pages/HomePageView');
const { default: ConverterPageView } = await import('../src/components/pages/ConverterPageView');
const { default: PricingPageView } = await import('../src/components/pages/PricingPageView');
const { default: NotFoundPageView } = await import('../src/components/pages/NotFoundPageView');
const { default: Header } = await import('../src/components/Header');
const { default: Footer } = await import('../src/components/Footer');
const { default: ConversionQueue } = await import('../src/components/ConversionQueue');
const { LegalDocument } = await import('../src/components/legal/LegalDocument');

/**
 * The automated accessibility check of issue #903: the core pages are mounted as a browser mounts them and audited with
 * axe-core against the rules tagged WCAG 2.0 and 2.1 level A and AA. jsdom lays nothing out and loads no stylesheet, so the
 * rules that need rendered pixels (colour contrast, target size) cannot run here and stay open audit rows of #903
 * (docs/policy-decisions.md, entry 178). The rule set has no baseline: any violation fails the test.
 */

const WCAG_TAGS = ['best-practice', 'wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const NEEDS_LAYOUT = ['color-contrast', 'target-size', 'scrollable-region-focusable'];

interface PageCase {
  name: string;
  locale: TestLocale;
  page: () => ReactNode;
}

const API_ORIGIN = 'https://convert.aquilaxk.site';

const PAGES: PageCase[] = [
  { name: 'home', locale: 'en', page: () => createElement(HomePageView, { dailyLimit: ANONYMOUS_DAILY_CONVERSIONS, apiOrigin: API_ORIGIN }) },
  { name: 'home in Korean', locale: 'ko', page: () => createElement(HomePageView, { dailyLimit: ANONYMOUS_DAILY_CONVERSIONS, apiOrigin: API_ORIGIN }) },
  { name: 'converter pair /pdf-to-docx', locale: 'en', page: () => createElement(ConverterPageView, { parsed: parsedSlug('pdf-to-docx'), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }) },
  { name: 'format page /pdf-converter', locale: 'en', page: () => createElement(ConverterPageView, { parsed: parsedSlug('pdf-converter'), dailyLimit: ANONYMOUS_DAILY_CONVERSIONS }) },
  { name: 'pricing', locale: 'en', page: () => createElement(PricingPageView, { anonymousDaily: ANONYMOUS_DAILY_CONVERSIONS }) },
  { name: 'pricing in Korean', locale: 'ko', page: () => createElement(PricingPageView, { anonymousDaily: ANONYMOUS_DAILY_CONVERSIONS }) },
  { name: 'not found', locale: 'en', page: () => createElement(NotFoundPageView) },
  {
    name: 'terms',
    locale: 'en',
    page: () =>
      createElement('div', null, createElement(Header), createElement('main', { id: 'main-content' }, createElement(LegalDocument, { id: 'terms', locale: 'en' })), createElement(Footer)),
  },
];

const noop = () => undefined;

const queueItem = (overrides: Partial<ConversionQueueItem>): ConversionQueueItem => ({
  id: 'item-1',
  file: new File(['sample'], 'diagram.png', { type: 'image/png' }),
  name: 'diagram.png',
  size: 4096,
  sourceFormat: 'png',
  targetFormat: 'webp',
  status: 'ready',
  progress: 0,
  options: { quality: 85 },
  ...overrides,
});

/** The conversion queue in one state, inside the landmarks of a page. */
const queuePage = (locale: TestLocale, label: string, items: ConversionQueueItem[], isConverting = false): PageCase => ({
  name: `queue ${label}`,
  locale,
  page: () =>
    createElement(
      'main',
      { id: 'main-content' },
      createElement('h1', null, 'Queue'),
      createElement(ConversionQueue, {
        items, isConverting, onRemoveItem: noop, onClearAll: noop, onUpdateTargetFormat: noop, onUpdateOptions: noop,
        onConvertAll: noop, onAddMoreFiles: noop, onImportFile: noop, onDownloadAllZip: noop,
      })
    ),
});

PAGES.push(
  queuePage('en', 'with no target chosen', [queueItem({ targetFormat: '' })]),
  queuePage('en', 'converting', [queueItem({ status: 'converting', progress: 64 })], true),
  queuePage('en', 'completed', [queueItem({ status: 'completed', progress: 100, resultUrl: 'blob:result', resultSize: 2048 })]),
  queuePage('ko', 'converting in Korean', [queueItem({ status: 'converting', progress: 64 })], true),
  queuePage('en', 'failed', [queueItem({ status: 'error', error: { code: 'server', problem: { detail: 'x', status: 400 } } })])
);

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  document.documentElement.removeAttribute('lang');
  vi.unstubAllGlobals();
});

async function audit({ locale, page }: Pick<PageCase, 'locale' | 'page'>): Promise<axe.Result[]> {
  document.documentElement.lang = locale;
  document.title = 'EasyConvert';
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: page() }));
  });
  const { violations } = await axe.run(document, {
    runOnly: { type: 'tag', values: WCAG_TAGS },
    rules: Object.fromEntries(NEEDS_LAYOUT.map((id) => [id, { enabled: false }])),
  });
  return violations;
}

const describeViolation = (v: axe.Result) => `${v.id} (${v.tags.filter((t) => /^wcag\d+$/.test(t)).join(',')}): ${v.help} @ ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`;

describe('the core pages pass the automated WCAG 2.1 AA audit', () => {
  it.each(PAGES.map((p) => [p.name, p] as const))('%s', async (_name, pageCase) => {
    expect((await audit(pageCase)).map(describeViolation)).toEqual([]);
  });
});

describe('the audit itself', () => {
  it('reports a button without a name and an image without alternative text', async () => {
    const broken = { locale: 'en' as const, page: () => createElement('main', null, createElement('button'), createElement('img', { src: 'x.png' })) };
    const found = (await audit(broken)).map((v) => v.id);
    expect(found.filter((id) => id === 'button-name' || id === 'image-alt').sort()).toEqual(['button-name', 'image-alt']);
  });
});

describe('keyboard and target-size guards that jsdom can see', () => {
  const mount = async (locale: TestLocale, page: () => ReactNode) => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: page() }));
    });
  };

  it('keeps the visually hidden file input out of the Tab order, so no focus stop is invisible', async () => {
    await mount('ko', () => createElement(HomePageView, { dailyLimit: ANONYMOUS_DAILY_CONVERSIONS, apiOrigin: API_ORIGIN }));
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.tabIndex).toBe(-1);
  });

  it('gives every footer link a 24 px minimum height (WCAG 2.5.8)', async () => {
    await mount('en', () => createElement(Footer));
    const links = Array.from(document.querySelectorAll('footer nav a'));
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((a) => !a.classList.contains('min-h-6'))).toEqual([]);
  });

  it('hands keyboard focus to the first download when the queue settles and the Convert button leaves', async () => {
    const props = { onRemoveItem: noop, onClearAll: noop, onUpdateTargetFormat: noop, onUpdateOptions: noop, onConvertAll: noop, onAddMoreFiles: noop, onImportFile: noop, onDownloadAllZip: noop };
    const converting = [queueItem({ status: 'converting', progress: 64 })];
    const done = [queueItem({ status: 'completed', progress: 100, resultUrl: 'blob:result', resultSize: 2048 })];
    const queue = (items: ConversionQueueItem[], isConverting: boolean) => createElement(ConversionQueue, { items, isConverting, ...props });
    await mount('en', () => queue(converting, true));
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      root?.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: queue(done, false) }));
    });
    expect(document.activeElement?.matches('a[download]')).toBe(true);
  });
});
