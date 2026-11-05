#!/usr/bin/env node
// Asks a running server (`next start` of the build, or the web image) for paths the site does and does not offer, and requires
// the answers a visitor and a crawler get: 404 with a robots noindex tag and the 404 page's own title for a path the site
// offers no page at, in English and under /ko, whether it has one segment or several, and 200 without one for a page that
// exists (docs/policy-decisions.md, entry 145). The tests of the slug page call its functions; this is the one check that goes
// through the server, where a page that wraps notFound() in a boundary, a route that shadows the catch-all, or a rewrite of the
// locale middleware that changes the path would answer 200.
//
//   node scripts/check-built-statuses.mjs <base url>

import { readFileSync } from 'node:fs';

const [baseUrl] = process.argv.slice(2);
const REQUEST_TIMEOUT_MS = 15_000;

const messages = Object.fromEntries(
  ['en', 'ko'].map((locale) => [locale, JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')).meta])
);
const localeOf = (path) => (/^\/ko(?:\/|$)/i.test(path) ? 'ko' : 'en');

/** A path the site offers no page at: 404, noindex, and the 404 page's own title in the language of the path, not the layout's. */
const notFound = (path) => ({ path, status: 404, noindex: true, title: messages[localeOf(path)].notFound.title });
const badRequest = (path) => ({ path, status: 400 });
const page = (path, status = 200) => ({ path, status, noindex: false });

/** The routes of the app that are pages of their own, and the status each answers (the account page redirects to the dashboard). */
const ROUTES = [
  ['/dashboard/api-keys', 200],
  ['/api-docs', 200],
  ['/status', 200],
  ['/unit-converter', 200],
  ['/auth', 200],
  ['/account', 307],
];

const EXPECTED = [
  notFound('/nonexistent-page-xyz'),
  notFound('/foo/bar'),
  notFound('/pdf-to-jpg/extra'),
  notFound('/pdf-to-jpg%20'),
  notFound('/%09pdf-to-jpg'),
  notFound('/en/pdf-to-jpg%20'),
  notFound('/robots.txt'),
  notFound('/foo.html'),
  notFound('/wp-login.php'),
  notFound('/.env'),
  notFound('/.git/config'),
  notFound('/api'),
  notFound('/ko/nonexistent-page-xyz'),
  notFound('/ko/foo/bar'),
  notFound('/ko/robots.txt'),
  notFound('/ko/pdf-to-jpg%20'),
  notFound('/KO/pdf-to-jpg%20'),
  badRequest('/%E0%A4%A'),
  badRequest('/ko/%E0%A4%A'),
  badRequest('/en/%E0%A4%A'),
  badRequest('/pdf-to-jpg%E0%A4%A'),
  badRequest('/%c0%ae%c0%ae/etc'),
  badRequest('/ko/%c0%ae'),
  page('/pdf-to-jpg'),
  page('/ko/pdf-to-jpg'),
  ...ROUTES.map(([path, status]) => page(path, status)),
  ...ROUTES.map(([path]) => notFound(`${path}/x`)),
];

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

if (!baseUrl) fail(['usage: check-built-statuses.mjs <base url>']);

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name.toLowerCase(), value]));
}

function isNoindex(headers, html) {
  const robots = [...html.matchAll(/<meta\b[^>]*>/g)].map(([tag]) => attributes(tag)).filter((meta) => meta.name?.toLowerCase() === 'robots');
  const directives = [headers.get('x-robots-tag') ?? '', ...robots.map((meta) => meta.content ?? '')];
  return directives.some((directive) => /\bnoindex\b/i.test(directive));
}

async function answerOf(path) {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const html = await response.text();
  return { status: response.status, title: /<title>([^<]*)<\/title>/.exec(html)?.[1], noindex: isNoindex(response.headers, html), html };
}

/** What a path answered that differs from what it must, one phrase each. */
function faultsOf(expected, answer) {
  const faults = [];
  if (answer.status !== expected.status) faults.push(`status ${answer.status}, expected ${expected.status}`);
  if (expected.noindex !== undefined && answer.noindex !== expected.noindex) faults.push(`noindex ${answer.noindex}, expected ${expected.noindex}`);
  if (expected.title !== undefined && answer.title !== expected.title) faults.push(`title ${answer.title}, expected ${expected.title}`);
  const layoutTitle = messages[localeOf(expected.path)].site.title;
  if (expected.status === 404 && answer.html.includes(layoutTitle)) faults.push(`the document names the title of the layout "${layoutTitle}", which retitles the tab after load`);
  return faults;
}

const failures = [];
for (const expected of EXPECTED) {
  const answer = await answerOf(expected.path).catch((error) => fail([`${expected.path}: ${error.message}`]));
  const faults = faultsOf(expected, answer);
  if (faults.length > 0) failures.push(`${expected.path}: ${faults.join('; ')}`);
}
if (failures.length > 0) fail(failures);
console.log(`${EXPECTED.length} paths answered as a visitor and a crawler need on ${new URL(baseUrl).origin}`);
