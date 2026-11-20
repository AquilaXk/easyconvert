import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ko from '../messages/ko.json';
import ApiDocsPageView from '../src/components/pages/ApiDocsPageView';
import { CODE_AREAS, PROBLEM_TYPE_STATUSES, codeRows } from '../src/lib/error-inventory';
import { PROBLEM_TYPES_PAGE_PATH, PROBLEM_TYPE_BASE, problemNameOfType } from '../src/lib/refusal-codes';
import { attrOf, allElements, renderDom, select, visibleText } from './helpers/rendered-dom';
import { testMessages } from './helpers/intl-messages';

/**
 * The errors page of the API documentation lists the problem types and refusal codes of src/lib/error-inventory.ts, and each
 * `type` URI the API answers with points to one of its anchors. These tests tie the tables to the messages, to the names and
 * statuses src raises, and to the rendered page.
 */

const SRC = path.resolve(__dirname, '..', 'src');
const SITE = 'https://convert.aquilaxk.site';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

const sources = sourceFiles(SRC).map((file) => ({ file: path.relative(SRC, file), text: fs.readFileSync(file, 'utf-8') }));

describe('the problem type URI', () => {
  it('is an anchor of the errors page on the public site', () => {
    expect(PROBLEM_TYPES_PAGE_PATH).toBe('/api-docs/errors');
    expect(PROBLEM_TYPE_BASE).toBe(`${SITE}/api-docs/errors#`);
  });

  it('is read back to its name, also from the base the URIs had before, and from no other origin', () => {
    expect(problemNameOfType(`${PROBLEM_TYPE_BASE}storage-full`)).toBe('storage-full');
    expect(problemNameOfType('https://api.easyconvert.io/problems/storage-full')).toBe('storage-full');
    expect(problemNameOfType('https://example.org/api-docs/errors#storage-full')).toBeUndefined();
    expect(problemNameOfType('about:blank')).toBeUndefined();
  });

  it('is built from the shared base only: no file of src but the base itself names the old host', () => {
    expect(sources.filter(({ text }) => text.includes('api.easyconvert.io')).map(({ file }) => file)).toEqual(['lib/refusal-codes.ts']);
  });
});

describe('the problem types', () => {
  const names = Object.keys(PROBLEM_TYPE_STATUSES).sort();

  it.each([
    ['en', en],
    ['ko', ko],
  ])('are the problems that %s words, no more and no fewer', (_locale, messages) => {
    expect(Object.keys(messages.errors.problems).sort()).toEqual(names);
  });

  it('are the names src sends in a type', () => {
    const sent = new Set(
      sources.flatMap(({ text }) => [...text.matchAll(/(?:\$\{PROBLEM_TYPE_BASE\}|PROBLEM_TYPE_BASE \+ ')([a-z][a-z0-9-]*)/g)].map((match) => match[1]))
    );
    expect([...sent].sort()).toEqual(names);
  });
});

describe('the refusal codes', () => {
  const rows = codeRows();

  it.each([
    ['en', en],
    ['ko', ko],
  ])('have a sentence in %s for every code of every area', (_locale, messages) => {
    const missing = rows.filter(({ area, code }) => typeof (messages.errors[area] as Record<string, unknown>)[code] !== 'string');
    expect(missing).toEqual([]);
  });

  it('anchor every code once, apart from every problem name', () => {
    const anchors = [...Object.keys(PROBLEM_TYPE_STATUSES), ...rows.filter((row) => row.anchored).map((row) => row.code)];
    expect(anchors.filter((id, index) => anchors.indexOf(id) !== index)).toEqual([]);
    expect(new Set(anchors)).toEqual(new Set([...Object.keys(PROBLEM_TYPE_STATUSES), ...rows.map((row) => row.code)]));
  });

  it('list every status the routes and error classes of src give a code', () => {
    const consts = new Map<string, number>();
    for (const { text } of sources) {
      for (const match of text.matchAll(/const (HTTP_[A-Z_]+|[A-Z_]+_STATUS)\s*=\s*(\d{3})\b/g)) consts.set(match[1], Number(match[2]));
    }
    const statusOf = (token: string) => (/^\d{3}$/.test(token) ? Number(token) : consts.get(token));
    const listed = (code: string) => new Set(rows.filter((row) => row.code === code).flatMap((row) => row.statuses));
    const known = new Set(rows.map((row) => row.code));
    const unlisted: string[] = [];
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/\(\s*(\d{3}|HTTP_[A-Z_]+)\s*,\s*'([a-z_]+)'/g)) {
        const status = statusOf(match[1]);
        if (known.has(match[2]) && status !== undefined && !listed(match[2]).has(status)) unlisted.push(`${file}: ${status} ${match[2]}`);
      }
      for (const block of text.split(/^(?=[ \t]*(?:export )?(?:abstract )?class )/m)) {
        const code = /refusalCode[^=\n]*=\s*'([a-z_]+)'/.exec(block)?.[1];
        const token = /readonly status\s*=\s*(\w+)/.exec(block)?.[1];
        const status = token === undefined ? undefined : statusOf(token);
        if (code && status !== undefined && !listed(code).has(status)) unlisted.push(`${file}: ${status} ${code}`);
      }
    }
    expect(unlisted).toEqual([]);
  });
});

describe.each(['en', 'ko'] as const)('the errors page in %s', (locale) => {
  const dom = renderDom(createElement(ApiDocsPageView, { topic: 'errors' }), locale);
  const messages = testMessages(locale);
  const rowOf = (id: string) => allElements(dom).find((element) => element.tagName === 'tr' && attrOf(element, 'id') === id);
  /** The cells of a row; the name is read without the breaks the page allows in it on a narrow screen. */
  const cells = (id: string) => select(rowOf(id)!, 'td').map((cell, index) => (index === 0 ? visibleText(cell).replaceAll(' ', '') : visibleText(cell)));

  it('has an anchor row for every problem type, with its status and its sentence', () => {
    for (const [name, status] of Object.entries(PROBLEM_TYPE_STATUSES)) {
      expect(cells(name), name).toEqual([name, String(status), (messages.errors.problems as Record<string, string>)[name]]);
    }
  });

  it('has an anchor row for every code, with its statuses', () => {
    for (const row of codeRows().filter((r) => r.anchored)) {
      const [code, status] = cells(row.code);
      expect([code, status], row.code).toEqual([row.code, row.statuses.join(', ')]);
    }
  });

  it('words a code with the sentence of its area, unless the sentence needs a number of the request', () => {
    const documented = new Set(['login_locked', 'mail_rate_limited', 'file_too_large']);
    for (const area of CODE_AREAS) {
      for (const row of codeRows().filter((r) => r.area === area && !documented.has(r.code))) {
        const sentence = (messages.errors[area] as Record<string, string>)[row.code];
        expect(visibleText(select(dom, 'main')[0]), `${area} ${row.code}`).toContain(sentence);
      }
    }
  });
});
