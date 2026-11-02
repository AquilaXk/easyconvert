#!/usr/bin/env node
// Checks the HTML that `next build` prerendered under <dir> (.next/server/app): every page that names a canonical URL names it
// and its hreflang alternates, x-default included, as absolute URLs on APP_ORIGIN, since search engines read hreflang only
// as absolute URLs. A page with no canonical (a redirect, the not-found page) is left out, but at least one page must name one.
// Dockerfile.web runs it after the build, so an image whose pages were built without the public origin is never made.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [dir] = process.argv.slice(2);
const originText = process.env.APP_ORIGIN;

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

if (!dir) fail(['usage: check-built-alternates.mjs <directory of prerendered pages>']);
if (!originText) fail(['APP_ORIGIN is not set: the build cannot write absolute canonical and hreflang URLs without the public origin.']);
const origin = new URL(originText).origin;

function htmlFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

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

/** What is wrong with the links of one page, or undefined for a page that names no canonical URL. */
function problemsOf(html) {
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => attributes(tag));
  const canonical = links.filter((link) => link.rel === 'canonical');
  const alternates = links.filter((link) => link.rel === 'alternate' && link.hreflang);
  if (canonical.length === 0 && alternates.length === 0) return undefined;
  const problems = [];
  if (canonical.length !== 1) problems.push(`${canonical.length} canonical links`);
  if (!alternates.some((link) => link.hreflang === 'x-default')) problems.push('no x-default alternate');
  for (const link of [...canonical, ...alternates]) {
    if (!isOnOrigin(link.href)) problems.push(`${link.hreflang ?? 'canonical'} ${link.href} is not an absolute URL on ${origin}`);
  }
  return problems;
}

let named = 0;
const failures = [];
for (const file of htmlFiles(dir)) {
  const problems = problemsOf(readFileSync(file, 'utf-8'));
  if (problems === undefined) continue;
  named++;
  for (const problem of problems) failures.push(`${path.relative(dir, file)}: ${problem}`);
}
if (named === 0) failures.push(`no prerendered page under ${dir} names a canonical URL`);
if (failures.length > 0) fail(failures);
console.log(`${named} prerendered pages name absolute canonical and hreflang URLs on ${origin}`);
