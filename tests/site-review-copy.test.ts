import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as sessionHandler } from '../src/app/api/auth/me/route';
import ApiDocsPageView from '../src/components/pages/ApiDocsPageView';
import ConverterPageView from '../src/components/pages/ConverterPageView';
import HomePageView from '../src/components/pages/HomePageView';
import { apiCurlExample } from '../src/components/workbench/HomeEditorialSections';
import { formatChipLabel } from '../src/lib/format-full-names';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { REGISTRY_STATS } from '../src/lib/registry-stats';
import { getViewerPlan, refreshViewerPlan, setViewerPlan } from '../src/lib/viewer-plan';
import { allElements, attrOf, headings, links, renderDom, select, visibleText, type DomElement } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

const ORIGIN = 'https://convert.example.org';

const slugPage = (slug: string, locale: TestLocale = 'en') => {
  const parsed = parseConverterSlug(slug);
  if (!parsed) throw new Error(`${slug} is not a page`);
  return select(renderDom(createElement(ConverterPageView, { parsed, dailyLimit: 10 }), locale), 'main')[0];
};
const homePage = (locale: TestLocale = 'en') =>
  select(renderDom(createElement(HomePageView, { dailyLimit: 10, apiOrigin: ORIGIN }), locale), 'main')[0];
const chipTexts = (root: DomElement, hrefSuffix: string) =>
  links(root)
    .filter((link) => link.href.endsWith(hrefSuffix))
    .map((link) => link.text);

afterEach(() => vi.unstubAllGlobals());

describe('format lists name each format by its own name', () => {
  it('gives no two formats of the registry the same label, in any category', () => {
    const labels = REGISTRY_STATS.categories.flatMap((category) => category.formats.map((format) => formatChipLabel(format.id)));
    const duplicated = labels.filter((label, index) => labels.indexOf(label) !== index);
    expect(duplicated).toEqual([]);
    for (const category of REGISTRY_STATS.categories) {
      const own = category.formats.map((format) => formatChipLabel(format.id));
      expect(new Set(own).size, category.id).toBe(own.length);
    }
  });

  it('lists JPG once and Ultra HDR on the image category page', () => {
    const chips = links(slugPage('image-converter')).filter((link) => link.href.endsWith('-converter')).map((link) => link.text);
    expect(chips.filter((text) => text === 'JPG')).toHaveLength(1);
    expect(chips).toContain('Ultra HDR');
    expect(links(slugPage('image-converter')).find((link) => link.href === '/ultrahdr-converter')?.text).toBe('Ultra HDR');
  });

  it('lists XML and ALTO apart in the Documents catalog of the home page', () => {
    const chips = links(homePage()).filter((link) => link.href.endsWith('-converter'));
    expect(chips.find((link) => link.href === '/alto-converter')?.text).toBe('ALTO');
    expect(chips.filter((link) => link.text === 'XML').map((link) => link.href)).not.toContain('/alto-converter');
  });

  it('names Ultra HDR, not its extension or its run-together id, in the Convert to PDF list', () => {
    const texts = chipTexts(slugPage('pdf-converter'), '-to-pdf');
    expect(texts).toContain('Ultra HDR to PDF');
    expect(texts.filter((text) => /ultrahdr/i.test(text))).toEqual([]);
    expect(texts).toContain('ET to PDF');
  });
});

describe('the home page API sample', () => {
  it('posts to the base URL the API documentation shows, not another host', () => {
    const sample = select(homePage(), 'code').map(visibleText).find((text) => text.includes('curl -X POST')) ?? '';
    expect(sample).toContain(`curl -X POST ${ORIGIN}/api/v1/convert`);
    expect(sample).not.toContain('api.easyconvert.com');
  });

  it('reads the same origin as the introduction of the API documentation', () => {
    vi.stubEnv('APP_ORIGIN', ORIGIN);
    const docs = visibleText(select(renderDom(createElement(ApiDocsPageView, { topic: 'introduction' })), 'main')[0]);
    expect(docs).toContain(`${ORIGIN}/api/v1/convert`);
    expect(apiCurlExample(new URL(process.env.APP_ORIGIN ?? '').origin)).toContain(`${ORIGIN}/api/v1/convert`);
    vi.unstubAllEnvs();
  });
});

describe('the pages that do not convert say what they do', () => {
  it.each([
    ['merge-pdf', 'Select the files to combine', 'Select Files'],
    ['compress-pdf', 'Select your file to compress', 'Select File'],
    ['compress-png', 'Select your file to compress', 'Select File'],
    ['compress-jpg', 'Select your file to compress', 'Select File'],
    ['pdf-ocr', 'Select your file to read its text', 'Select File'],
  ])('words the upload card of /%s', (slug, heading, button) => {
    const page = slugPage(slug);
    const text = visibleText(page);
    expect(headings(page)).toContain(heading);
    expect(text).not.toContain('Select your file to convert');
    expect(select(page, 'button').map(visibleText)).toContain(button);
    expect(allElements(page).filter((el) => attrOf(el, 'type') === 'file').map((el) => attrOf(el, 'aria-label'))).not.toContain('Select files to convert');
  });

  it('words the merge page in Korean in the polite style', () => {
    const page = slugPage('merge-pdf', 'ko');
    expect(headings(page).filter((heading) => heading.includes('선택'))).toEqual(['병합할 파일을 선택해 주세요']);
    expect(visibleText(page)).not.toContain('변환할 파일을 선택해 주세요');
  });

  it('keeps the wording of a conversion page', () => {
    expect(headings(slugPage('png-to-jpg')).filter((heading) => heading.startsWith('Select '))).toEqual(['Select your file to convert']);
  });
});

describe('the introduction of the API documentation in Korean', () => {
  it('has no English description among the fields of the error body', () => {
    const text = visibleText(select(renderDom(createElement(ApiDocsPageView, { topic: 'introduction' }), 'ko'), 'main')[0]);
    for (const english of [
      'A URI reference identifying the problem type.',
      'A short, human-readable summary of the problem type.',
      'Legacy compatibility flag (always false).',
      'Legacy compatibility error message mirroring detail.',
    ]) {
      expect(text).not.toContain(english);
    }
    expect(text).toContain(testMessages('ko').apiDocs.intro.problemFields.type);
  });

  it('keeps the English descriptions in English', () => {
    const text = visibleText(select(renderDom(createElement(ApiDocsPageView, { topic: 'introduction' })), 'main')[0]);
    expect(text.match(/A URI reference identifying the (?:problem type|specific occurrence)\./g)).toEqual([
      'A URI reference identifying the problem type.',
      'A URI reference identifying the specific occurrence.',
    ]);
  });
});

describe('/api/auth/me for a visitor without a session', () => {
  it('answers 200 with a signed-out body, so the browser logs no error', async () => {
    const res = await sessionHandler(new NextRequest('http://localhost:3000/api/auth/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, authenticated: false, user: null });
  });

  it('leaves the viewer anonymous when the client reads that answer', async () => {
    setViewerPlan('free');
    vi.stubGlobal('fetch', async () => Response.json({ success: false, authenticated: false, user: null }));
    await refreshViewerPlan();
    expect(getViewerPlan()).toBe('anonymous');
  });
});

describe('small copy', () => {
  it('writes the headings of the home catalog in the singular for every category', () => {
    const text = visibleText(homePage());
    expect(text).toContain('Document formats');
    expect(text).toContain('Common document pairs');
    expect(text).not.toMatch(/Documents formats|Common Documents Pairs/i);
  });

  it('drops the open-source clause from the contact page description and the .com from the footer', () => {
    const en = testMessages('en');
    expect(en.slugPages.info.contact.description).toBe('Get in touch with our team for questions or feedback.');
    expect(JSON.stringify(testMessages('ko').slugPages.info.contact)).not.toContain('오픈');
    expect(en.footer.copyright).toBe('© 2026 EasyConvert');
  });
});
