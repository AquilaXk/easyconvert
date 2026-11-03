import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The check of a running server (docs/policy-decisions.md, entry 145) is run against servers that answer as the site does and
 * as a regression would: a junk path answered 200, a 404 under /ko with the home page's title, a 404 that no crawler is told
 * to skip, and a page that exists answered 404.
 */

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-built-statuses.mjs');
const run = promisify(execFile);
const servers: Server[] = [];

const PAGES = new Set(['/pdf-to-jpg', '/ko/pdf-to-jpg']);

const html = (title: string, robots: boolean) =>
  `<!DOCTYPE html><html><head><title>${title}</title>${robots ? '<meta name="robots" content="noindex"/>' : ''}</head><body></body></html>`;

interface Faults {
  soft404?: string;
  homeTitle?: boolean;
  noRobots?: boolean;
  pageGone?: boolean;
}

async function serve(faults: Faults = {}): Promise<string> {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(request.url ?? '/');
    const exists = PAGES.has(pathname) && !faults.pageGone;
    const status = exists || pathname === faults.soft404 ? 200 : 404;
    const notFoundTitle = pathname.startsWith('/ko/') ? '페이지를 찾을 수 없어요 | EasyConvert' : 'Page not found | EasyConvert';
    response.writeHead(status, { 'content-type': 'text/html' });
    response.end(html(status === 404 && !faults.homeTitle ? notFoundTitle : 'EasyConvert | Online File Converter', status === 404 && !faults.noRobots));
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
    ['a junk slug answered 200', { soft404: '/nonexistent-page-xyz' }, '/nonexistent-page-xyz'],
    ['a path of several segments answered 200', { soft404: '/foo/bar' }, '/foo/bar'],
    ['a path under /ko answered 200', { soft404: '/ko/nonexistent-page-xyz' }, '/ko/nonexistent-page-xyz'],
    ['a page with a space after it answered 200', { soft404: '/pdf-to-jpg ' }, '/pdf-to-jpg%20'],
    ['a page with a tab before it answered 200', { soft404: '/\tpdf-to-jpg' }, '/%09pdf-to-jpg'],
    ['a utility page the service does not run answered 200', { soft404: '/compress-png' }, '/compress-png'],
    ['a 404 that carries the title of the home page', { homeTitle: true }, '/ko/foo/bar'],
    ['a 404 that carries no noindex', { noRobots: true }, '/foo/bar'],
    ['a page that exists answered 404', { pageGone: true }, '/pdf-to-jpg'],
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
