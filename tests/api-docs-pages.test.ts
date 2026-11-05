import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateStaticParams, dynamicParams } from '../src/app/[locale]/api-docs/[topic]/page';
import { API_DOC_TOPICS, apiDocsHref, type ApiDocTopicSlug } from '../src/components/api-docs/topics';
import ApiDocsPageView from '../src/components/pages/ApiDocsPageView';
import { buildOpenApiDocument } from '../src/lib/api/openapi';
import { allElements, attrOf, links, renderDom, select, visibleText, type DomElement } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

const ORIGIN = 'https://convert.example.org';

/**
 * Operations the OpenAPI document publishes that no page of the documentation shows, each with why. A new public operation
 * fails the coverage test until a page shows it or this table says why it does not.
 */
const LEFT_OUT: Readonly<Record<string, string>> = {
  'GET /api/keys': 'key management lives on the dashboard',
  'POST /api/keys': 'key management lives on the dashboard',
  'PATCH /api/keys/{id}': 'key management lives on the dashboard',
  'DELETE /api/keys/{id}': 'key management lives on the dashboard',
  'POST /api/keys/{id}/rotate': 'key management lives on the dashboard',
  'POST /api/v1/storage/credentials': 'storage credentials are an account setting',
  'GET /api/v1/storage/credentials': 'storage credentials are an account setting',
  'DELETE /api/v1/storage/credentials/{id}': 'storage credentials are an account setting',
  'GET /api/webhooks/dlq': 'webhook dead letters are an operator tool',
  'DELETE /api/webhooks/dlq': 'webhook dead letters are an operator tool',
  'GET /api/webhooks/dlq/{id}': 'webhook dead letters are an operator tool',
  'DELETE /api/webhooks/dlq/{id}': 'webhook dead letters are an operator tool',
  'POST /api/webhooks/dlq/{id}/replay': 'webhook dead letters are an operator tool',
  'POST /api/v1/webhooks/secrets/rotate': 'it rotates the secret of a webhook endpoint, which only the dashboard registers',
  'GET /api/v1/usage': 'it needs the read:usage scope, which no key the dashboard creates can hold',
};

function publishedOperations(): string[] {
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { 'x-internal'?: boolean }>> };
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([, operation]) => operation['x-internal'] !== true)
      .map(([method]) => `${method.toUpperCase()} ${path}`)
  );
}

const shown = API_DOC_TOPICS.flatMap((topic) => topic.operations.map((op) => `${op.method.toUpperCase()} ${op.path}`));

const page = (topic: ApiDocTopicSlug, locale: TestLocale = 'en') => renderDom(createElement(ApiDocsPageView, { topic }), locale);
const main = (dom: DomElement) => select(dom, 'main')[0];

beforeEach(() => vi.stubEnv('APP_ORIGIN', ORIGIN));
afterEach(() => vi.unstubAllEnvs());

describe('the API documentation covers the public API', () => {
  it('shows every operation the OpenAPI document publishes once, or says why it leaves it out', () => {
    const published = publishedOperations();
    expect(published.filter((op) => !shown.includes(op) && !(op in LEFT_OUT))).toEqual([]);
    expect(shown.filter((op, index) => shown.indexOf(op) !== index)).toEqual([]);
    expect(shown.filter((op) => !published.includes(op))).toEqual([]);
    expect(Object.keys(LEFT_OUT).filter((op) => shown.includes(op) || !published.includes(op))).toEqual([]);
  });

  it('prerenders a page for each topic but the introduction, which is /api-docs, and no other', () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams().map((params) => params.topic)).toEqual(
      API_DOC_TOPICS.filter((topic) => topic.slug !== 'introduction').map((topic) => topic.slug)
    );
  });
});

describe.each<TestLocale>(['en', 'ko'])('each page of the API documentation in %s', (locale) => {
  const messages = testMessages(locale).apiDocs;

  it.each(API_DOC_TOPICS.map((topic) => topic.slug))('%s has its title, the topic list and a contents list of its own headings', (topic) => {
    const dom = page(topic, locale);
    expect(select(dom, 'h1').map(visibleText)).toEqual([messages.topics[topic].title]);

    const navs = select(dom, 'nav', 'aria-label', messages.nav.label);
    expect(navs.length).toBeGreaterThan(0);
    for (const nav of navs) {
      const prefix = locale === 'ko' ? '/ko' : '';
      expect(links(nav).map((link) => link.href)).toEqual(API_DOC_TOPICS.map((entry) => prefix + apiDocsHref(entry.slug)));
      const current = allElements(nav).filter((el) => attrOf(el, 'aria-current') === 'page');
      expect(current.map((el) => attrOf(el, 'href'))).toEqual([prefix + apiDocsHref(topic)]);
    }

    const headingIds = new Set(allElements(main(dom)).filter((el) => /^h[23]$/.test(el.tagName)).map((el) => attrOf(el, 'id')));
    const toc = select(dom, 'nav', 'aria-label', messages.toc);
    expect(toc.length).toBeGreaterThan(0);
    const targets = links(toc[0]).map((link) => link.href);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((href) => !headingIds.has(href.replace(/^#/, '')))).toEqual([]);
  });
});

describe('what the documentation shows', () => {
  it('sends every example to the site origin and to no other host', () => {
    for (const topic of API_DOC_TOPICS) {
      const code = select(main(page(topic.slug)), 'pre').map(visibleText);
      const urls = code.flatMap((sample) => sample.match(/https?:\/\/[^\s"'/<]+/g) ?? []);
      expect(urls.filter((url) => url !== ORIGIN), topic.slug).toEqual([]);
    }
    expect(visibleText(main(page('introduction')))).toContain(`${ORIGIN}/api/v1/convert`);
  });

  it('carries no marketing copy, no key field and no method filter', () => {
    const text = API_DOC_TOPICS.map((topic) => visibleText(page(topic.slug))).join('\n');
    expect(text).not.toMatch(/Enterprise|zero-heap|dead-letter|RBAC|x-internal/i);
    for (const topic of API_DOC_TOPICS) {
      const dom = main(page(topic.slug));
      expect(select(dom, 'input'), topic.slug).toEqual([]);
      expect(select(dom, 'button').map((button) => attrOf(button, 'aria-label'))).toEqual(
        select(dom, 'pre').map(() => testMessages('en').apiDocs.operation.copy)
      );
    }
  });

  it('names no route of the web application, the key management or the dead letters', () => {
    const text = API_DOC_TOPICS.map((topic) => visibleText(main(page(topic.slug)))).join('\n');
    expect(text).not.toMatch(/\/api\/(?:queue|convert\b|webhooks\/dlq|auth|account|storage\/multipart|v1\/storage\/credentials)|\/api\/keys(?:\/\{id\}|\b(?!\/usage))/);
  });

  it('says who may call each operation: anyone for the formats, a scoped key for a conversion', () => {
    expect(visibleText(main(page('formats')))).toContain('None. Anyone can call this endpoint.');
    expect(visibleText(main(page('convert')))).toContain('An API key with the convert:write scope');
    expect(visibleText(main(page('convert', 'ko')))).toContain('convert:write 권한 범위가 있는 API 키');
  });

  it('keeps the OpenAPI document one plain link away', () => {
    expect(links(main(page('introduction'))).filter((link) => link.href === '/api/v1/openapi.json')).toHaveLength(1);
  });
});
