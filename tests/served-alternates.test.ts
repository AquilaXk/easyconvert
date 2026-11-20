import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The boot check of the web image asks the server for pages and requires each to name one canonical URL and hreflang
 * alternates, x-default included, as absolute URLs on the origin the server runs with, since search engines read hreflang only
 * so. The pages render per request (docs/policy-decisions.md, entry 370), so the check reads them from a server, here one that
 * answers as the site does and as a regression would.
 */

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-served-alternates.mjs');
const ORIGIN = 'https://convert.example.test';
const run = promisify(execFile);
const servers: Server[] = [];

const PAGES = ['/', '/ko', '/pdf-to-jpg', '/ko/pdf-to-jpg', '/api-docs', '/ko/api-docs', '/terms', '/ko/terms', '/pricing', '/ko/pricing'];

function page(canonical: string, alternates: Record<string, string>): string {
  const links = Object.entries(alternates).map(([lang, href]) => `<link rel="alternate" hrefLang="${lang}" href="${href}"/>`);
  return `<!DOCTYPE html><html><head><link rel="canonical" href="${canonical}"/>${links.join('')}</head><body></body></html>`;
}

/** The page the site sends for `pathname` when the server was given `origin`. */
function absolutePage(pathname: string, origin = ORIGIN): string {
  const korean = pathname === '/ko' || pathname.startsWith('/ko/');
  const english = korean ? pathname.slice('/ko'.length) || '/' : pathname;
  const koreanPath = english === '/' ? '/ko' : `/ko${english}`;
  return page(`${origin}${korean ? koreanPath : english}`, {
    en: `${origin}${english}`,
    ko: `${origin}${koreanPath}`,
    'x-default': `${origin}${english}`,
  });
}

type Answer = { status: number; html: string };

async function serve(answer: (pathname: string) => Answer): Promise<string> {
  const server = createServer((request, response) => {
    const { status, html } = answer(new URL(request.url ?? '/', 'http://localhost').pathname);
    response.writeHead(status, { 'content-type': 'text/html' });
    response.end(html);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function check(base: string, origin: string | null = ORIGIN): Promise<{ status: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, APP_ORIGIN: origin ?? undefined };
  if (origin === null) delete env.APP_ORIGIN;
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, base], { env });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('the served pages name absolute alternates', () => {
  it('passes pages whose canonical and alternates are absolute on the origin, and says how many it read', async () => {
    const base = await serve((pathname) => ({ status: 200, html: absolutePage(pathname) }));
    const result = await check(base);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${PAGES.length} pages name absolute canonical and hreflang URLs on ${ORIGIN}\n`);
  });

  it('asks for the home page, a converter, the API docs, the legal text and pricing in both languages', async () => {
    const asked: string[] = [];
    const base = await serve((pathname) => {
      asked.push(pathname);
      return { status: 200, html: absolutePage(pathname) };
    });
    await check(base);

    expect(asked).toEqual(PAGES);
  });

  it('fails a page with root-relative links, as a server without the origin writes them, and names the page', async () => {
    const base = await serve((pathname) => ({
      status: 200,
      html: pathname === '/ko/pdf-to-jpg' ? page('/ko/pdf-to-jpg', { en: '/pdf-to-jpg', ko: '/ko/pdf-to-jpg', 'x-default': '/pdf-to-jpg' }) : absolutePage(pathname),
    }));
    const result = await check(base);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/ko/pdf-to-jpg: canonical /ko/pdf-to-jpg is not an absolute URL');
    expect(result.stderr).not.toContain('/terms');
  });

  it('fails a page without an x-default alternate, or on another origin', async () => {
    const noDefault = await serve((pathname) => ({
      status: 200,
      html: pathname === '/terms' ? page(`${ORIGIN}/terms`, { en: `${ORIGIN}/terms`, ko: `${ORIGIN}/ko/terms` }) : absolutePage(pathname),
    }));
    const missing = await check(noDefault);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('/terms: no x-default alternate');

    const elsewhere = await serve((pathname) => ({ status: 200, html: absolutePage(pathname, 'https://other.example.test') }));
    const wrongOrigin = await check(elsewhere);
    expect(wrongOrigin.status).toBe(1);
    expect(wrongOrigin.stderr).toContain(`is not an absolute URL on ${ORIGIN}`);
  });

  it('fails a page that names no canonical URL at all, and a page that does not answer 200', async () => {
    const bare = await serve((pathname) => ({ status: 200, html: pathname === '/pricing' ? '<!DOCTYPE html><html><head></head></html>' : absolutePage(pathname) }));
    const noCanonical = await check(bare);
    expect(noCanonical.status).toBe(1);
    expect(noCanonical.stderr).toContain('/pricing: names no canonical URL');

    const broken = await serve((pathname) => (pathname === '/api-docs' ? { status: 500, html: 'error' } : { status: 200, html: absolutePage(pathname) }));
    const failed = await check(broken);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('/api-docs: answered 500, not 200');
  });

  it('fails without an origin to check against, without a base URL, and when the server cannot be reached', async () => {
    const base = await serve((pathname) => ({ status: 200, html: absolutePage(pathname) }));
    expect((await check(base, null)).status).toBe(1);
    expect((await check('')).status).toBe(1);

    const closed = await serve(() => ({ status: 200, html: '' }));
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    const unreachable = await check(closed);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain('/: ');
  });
});
