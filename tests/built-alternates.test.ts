import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The image build checks the HTML `next build` prerendered: every page that names a canonical URL names it and its hreflang
 * alternates (x-default included) as absolute URLs on the public origin, since search engines read hreflang only so.
 * The check runs here on pages written as Next.js writes them.
 */

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-built-alternates.mjs');
const ORIGIN = 'https://convert.example.test';
const dirs: string[] = [];

function page(canonical: string, alternates: Record<string, string>): string {
  const links = Object.entries(alternates).map(([lang, href]) => `<link rel="alternate" hrefLang="${lang}" href="${href}"/>`);
  return `<!DOCTYPE html><html><head><link rel="canonical" href="${canonical}"/>${links.join('')}</head><body></body></html>`;
}

function builtApp(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'built-app-'));
  dirs.push(dir);
  for (const [file, html] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), html);
  }
  return dir;
}

function check(dir: string, origin: string | undefined) {
  const env = { ...process.env, APP_ORIGIN: origin };
  if (origin === undefined) delete env.APP_ORIGIN;
  const run = spawnSync(process.execPath, [SCRIPT, dir], { env, encoding: 'utf-8' });
  return { status: run.status, stderr: run.stderr };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ABSOLUTE = {
  'en.html': page(`${ORIGIN}/`, { en: `${ORIGIN}/`, ko: `${ORIGIN}/ko`, 'x-default': `${ORIGIN}/` }),
  'ko/status.html': page(`${ORIGIN}/ko/status`, { en: `${ORIGIN}/status`, ko: `${ORIGIN}/ko/status`, 'x-default': `${ORIGIN}/status` }),
  'en/account.html': '<!DOCTYPE html><html><head></head><body></body></html>',
};

describe('the prerendered pages name absolute alternates', () => {
  it('passes pages whose canonical and alternates are absolute on the origin', () => {
    expect(check(builtApp(ABSOLUTE), ORIGIN)).toMatchObject({ status: 0 });
  });

  it('fails a page with root-relative links, as a build without the origin writes them', () => {
    const relative = builtApp({ ...ABSOLUTE, 'en.html': page('/', { en: '/', ko: '/ko', 'x-default': '/' }) });
    const result = check(relative, ORIGIN);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('en.html');
  });

  it('fails a page without an x-default alternate, or on another origin', () => {
    const noDefault = builtApp({ 'en.html': page(`${ORIGIN}/`, { en: `${ORIGIN}/`, ko: `${ORIGIN}/ko` }) });
    expect(check(noDefault, ORIGIN).status).toBe(1);
    expect(check(builtApp(ABSOLUTE), 'https://other.example.test').status).toBe(1);
  });

  it('fails without an origin to check against, or with no page that names one', () => {
    expect(check(builtApp(ABSOLUTE), undefined).status).toBe(1);
    expect(check(builtApp({ 'en/account.html': ABSOLUTE['en/account.html'] }), ORIGIN).status).toBe(1);
  });
});
