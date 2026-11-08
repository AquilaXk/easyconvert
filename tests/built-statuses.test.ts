import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { testMessages } from './helpers/intl-messages';

/**
 * The check of a running server (docs/policy-decisions.md, entry 145) is run against servers that answer as the site does and
 * as a regression would: a junk path answered 200, a file path or an API prefix answered 500, a prefixed path redirected to a
 * page, a 404 under /ko with the home page's title in its head or only in the payload the browser hydrates from, a 404 that no
 * crawler is told to skip, and a page that exists answered 404.
 */

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-built-statuses.mjs');
const run = promisify(execFile);
const servers: Server[] = [];

const PAGES = new Set(['/pdf-to-jpg', '/ko/pdf-to-jpg', '/api-docs', '/pricing', '/auth']);
// The account page redirects to the dashboard, and the dashboard sends a visitor without a session to the login page.
const REDIRECTS = new Set(['/account', '/dashboard/api-keys']);

const titles = (pathname: string) => testMessages(/^\/ko\//i.test(pathname) ? 'ko' : 'en').meta;

const html = (title: string, robots: boolean, payload = '') =>
  `<!DOCTYPE html><html><head><title>${title}</title>${robots ? '<meta name="robots" content="noindex"/>' : ''}</head><body>${payload}</body></html>`;

interface Faults {
  /** The status a path answers instead of its own, by the path as requested. */
  answers?: Record<string, number>;
  homeTitle?: boolean;
  payloadTitle?: boolean;
  noRobots?: boolean;
  pageGone?: boolean;
}

async function serve(faults: Faults = {}): Promise<string> {
  const server = createServer((request, response) => {
    const rawUrl = request.url ?? '/';
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawUrl);
    } catch {
      const status = faults.answers?.[rawUrl] ?? 400;
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end('Bad Request');
      return;
    }
    const exists = (PAGES.has(pathname) && !faults.pageGone) || REDIRECTS.has(pathname);
    const status = faults.answers?.[pathname] ?? (REDIRECTS.has(pathname) ? 307 : exists ? 200 : 404);
    const { notFound, site } = titles(pathname);
    response.writeHead(status, { 'content-type': 'text/html' });
    const missing = status === 404;
    const payload = missing && faults.payloadTitle ? `<script>self.__next_f.push([1,"{\\"title\\":\\"${site.title}\\"}"])</script>` : '';
    response.end(html(missing && !faults.homeTitle ? notFound.title : site.title, missing && !faults.noRobots, payload));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function check(baseUrl: string | undefined) {
  try {
    const { stdout } = await run(process.execPath, baseUrl ? [SCRIPT, baseUrl] : [SCRIPT]);
    return { status: 0, stderr: '', stdout };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { status: failed.code, stderr: failed.stderr, stdout: '' };
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('the built server answers a path the site does not offer with 404 and a page that exists with 200', () => {
  it('passes a server that answers as the site does', async () => {
    const result = await check(await serve());
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['a junk slug answered 200', { answers: { '/nonexistent-page-xyz': 200 } }, '/nonexistent-page-xyz'],
    ['a path of several segments answered 200', { answers: { '/foo/bar': 200 } }, '/foo/bar'],
    ['a path under /ko answered 200', { answers: { '/ko/nonexistent-page-xyz': 200 } }, '/ko/nonexistent-page-xyz'],
    ['a page with a space after it answered 200', { answers: { '/pdf-to-jpg ': 200 } }, '/pdf-to-jpg%20'],
    ['a page with a tab before it answered 200', { answers: { '/\tpdf-to-jpg': 200 } }, '/%09pdf-to-jpg'],
    ['a page with a space after it under /en redirected to the page', { answers: { '/en/pdf-to-jpg ': 307 } }, '/en/pdf-to-jpg%20'],
    ['a page with a space after it under /KO redirected to the page', { answers: { '/KO/pdf-to-jpg ': 307 } }, '/KO/pdf-to-jpg%20'],
    ['a file path answered 500', { answers: { '/robots.txt': 500 } }, '/robots.txt'],
    ['a dotted name answered 500', { answers: { '/foo.html': 500 } }, '/foo.html'],
    ['a dotted probe answered 200', { answers: { '/wp-login.php': 200 } }, '/wp-login.php'],
    ['a dotfile path answered 500', { answers: { '/.env': 500 } }, '/.env'],
    ['an API prefix answered 500', { answers: { '/api': 500 } }, '/api'],
    ['a malformed percent escape answered 500', { answers: { '/%E0%A4%A': 500 } }, '/%E0%A4%A'],
    ['a malformed percent escape under /ko answered 500', { answers: { '/ko/%E0%A4%A': 500 } }, '/ko/%E0%A4%A'],
    ['an overlong UTF-8 percent escape answered 500', { answers: { '/%c0%ae%c0%ae/etc': 500 } }, '/%c0%ae%c0%ae/etc'],
    ['a route of the app with a segment after it answered 200', { answers: { '/dashboard/api-keys/x': 200 } }, '/dashboard/api-keys/x'],
    ['a 404 that carries the title of the home page', { homeTitle: true }, '/ko/foo/bar'],
    ['a 404 whose payload names the title of the home page', { payloadTitle: true }, '/ko/foo/bar'],
    ['a 404 that carries no noindex', { noRobots: true }, '/foo/bar'],
    ['a page that exists answered 404', { pageGone: true }, '/pdf-to-jpg'],
    ['a route of the app answered 404', { pageGone: true }, '/api-docs'],
    ['the account page answered 200 instead of its redirect', { answers: { '/account': 200 } }, '/account'],
  ] as const)('fails %s and names the path', async (_label, faults, named) => {
    const result = await check(await serve(faults));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(named);
  });

  it('fails when the server cannot be reached, and without a base URL', async () => {
    const url = await serve();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    expect((await check(url)).status).toBe(1);
    expect((await check(undefined)).status).toBe(1);
  }, 30_000);
});
