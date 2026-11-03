#!/usr/bin/env node
// Asks a running server (`next start` of the build, or the web image) for paths the site does and does not offer, and requires
// the answers a visitor and a crawler get: 404 with a robots noindex tag and the 404 page's own title for a path the site
// offers no page at, in English and under /ko, whether it has one segment or several, and 200 without one for a page that
// exists (docs/policy-decisions.md, entry 145). The tests of the slug page call its functions; this is the one check that goes
// through the server, where a page that wraps notFound() in a boundary, a route that shadows the catch-all, or a rewrite of the
// locale middleware that changes the path would answer 200.
//
//   node scripts/check-built-statuses.mjs <base url>

const [baseUrl] = process.argv.slice(2);
const REQUEST_TIMEOUT_MS = 15_000;

const NOT_FOUND_TITLE = { en: 'Page not found | EasyConvert', ko: '페이지를 찾을 수 없어요 | EasyConvert' };

/**
 * Each path and what the server must answer: the status, whether its robots tag says noindex, and for a 404 the title the
 * page names itself by, in the language of the path. The title is the 404 page's own, not the home page's from the layout.
 */
const EXPECTED = [
  { path: '/nonexistent-page-xyz', status: 404, noindex: true, title: NOT_FOUND_TITLE.en },
  { path: '/foo/bar', status: 404, noindex: true, title: NOT_FOUND_TITLE.en },
  { path: '/pdf-to-jpg/extra', status: 404, noindex: true, title: NOT_FOUND_TITLE.en },
  { path: '/pdf-to-jpg%20', status: 404, noindex: true, title: NOT_FOUND_TITLE.en },
  { path: '/%09pdf-to-jpg', status: 404, noindex: true, title: NOT_FOUND_TITLE.en },
  { path: '/compress-png', status: 404, noindex: true, title: NOT_FOUND_TITLE.en },
  { path: '/ko/nonexistent-page-xyz', status: 404, noindex: true, title: NOT_FOUND_TITLE.ko },
  { path: '/ko/foo/bar', status: 404, noindex: true, title: NOT_FOUND_TITLE.ko },
  { path: '/ko/pdf-to-jpg%20', status: 404, noindex: true, title: NOT_FOUND_TITLE.ko },
  { path: '/pdf-to-jpg', status: 200, noindex: false },
  { path: '/ko/pdf-to-jpg', status: 200, noindex: false },
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
  return { status: response.status, title: /<title>([^<]*)<\/title>/.exec(html)?.[1], noindex: isNoindex(response.headers, html) };
}

const failures = [];
for (const expected of EXPECTED) {
  const answer = await answerOf(expected.path).catch((error) => fail([`${expected.path}: ${error.message}`]));
  const wrongTitle = expected.title !== undefined && answer.title !== expected.title;
  if (answer.status !== expected.status || answer.noindex !== expected.noindex || wrongTitle) {
    failures.push(`${expected.path}: status ${answer.status}, noindex ${answer.noindex}, title ${answer.title}; expected status ${expected.status}, noindex ${expected.noindex}${expected.title ? `, title ${expected.title}` : ''}`);
  }
}
if (failures.length > 0) fail(failures);
console.log(`${EXPECTED.length} paths answered as a visitor and a crawler need on ${new URL(baseUrl).origin}`);
