#!/usr/bin/env node
// Asks a running server for pages and checks the links they send: each names one canonical URL and hreflang alternates, x-default
// included, as absolute URLs on APP_ORIGIN, since search engines read hreflang only as absolute URLs. The pages render per request
// (docs/policy-decisions.md, entry 370), so this reads them from the server as a crawler does, with the origin the server was given.
// scripts/boot-web-image.sh runs it on the web image, so an image whose pages write relative links is never made.
//
//   APP_ORIGIN=<origin the server runs with> node scripts/check-served-alternates.mjs <base url>

const [baseUrl] = process.argv.slice(2);
const originText = process.env.APP_ORIGIN;
const REQUEST_TIMEOUT_MS = 15_000;

// The pages of the home, a converter, the API docs, the legal text and pricing, in both languages: every kind of page that
// names a canonical URL.
const PAGES = ['/', '/ko', '/pdf-to-jpg', '/ko/pdf-to-jpg', '/api-docs', '/ko/api-docs', '/terms', '/ko/terms', '/pricing', '/ko/pricing'];

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

if (!baseUrl) fail(['usage: check-served-alternates.mjs <base url>']);
if (!originText) fail(['APP_ORIGIN is not set: there is no origin to check the canonical and hreflang URLs against.']);
const origin = new URL(originText).origin;

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name.toLowerCase(), value]));
}

function isOnOrigin(href) {
  try {
    return new URL(href).origin === origin && /^https?:\/\//.test(href);
  } catch {
    return false;
  }
}

/** What is wrong with the links of one page; a page that names neither a canonical URL nor an alternate is itself the problem. */
function problemsOf(html) {
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => attributes(tag));
  const canonical = links.filter((link) => link.rel === 'canonical');
  const alternates = links.filter((link) => link.rel === 'alternate' && link.hreflang);
  if (canonical.length === 0 && alternates.length === 0) return ['names no canonical URL'];
  const problems = [];
  if (canonical.length !== 1) problems.push(`${canonical.length} canonical links`);
  if (!alternates.some((link) => link.hreflang === 'x-default')) problems.push('no x-default alternate');
  for (const link of [...canonical, ...alternates]) {
    if (!isOnOrigin(link.href)) problems.push(`${link.hreflang ?? 'canonical'} ${link.href} is not an absolute URL on ${origin}`);
  }
  return problems;
}

async function fetchPage(path) {
  const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { status: response.status, html: await response.text() };
}

const failures = [];
for (const path of PAGES) {
  try {
    const { status, html } = await fetchPage(path);
    if (status !== 200) failures.push(`${path}: answered ${status}, not 200`);
    else for (const problem of problemsOf(html)) failures.push(`${path}: ${problem}`);
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failures.length > 0) fail(failures);
console.log(`${PAGES.length} pages name absolute canonical and hreflang URLs on ${origin}`);
