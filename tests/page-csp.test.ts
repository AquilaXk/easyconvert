import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { buildPageCsp, generatePageNonce, PAGE_NONCE_HEADER } from '../src/lib/security/page-csp';
import { middleware } from '../src/middleware';

/**
 * The page policy carries a nonce made for the request instead of 'unsafe-inline' for scripts (docs/policy-decisions.md,
 * entry 369). The middleware puts it on the response and on the request, where Next.js reads it while it renders; the layout
 * reads it from `x-nonce` for its two inline scripts.
 */

const request = vi.hoisted(() => ({ nonce: null as string | null }));

vi.mock('next/font/local', () => ({ default: (options: { variable: string }) => ({ variable: options.variable }) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(request.nonce === null ? {} : { 'x-nonce': request.nonce }),
}));
vi.mock('next-intl/server', () => ({
  setRequestLocale: () => undefined,
  getMessages: async () => ({}),
  getTranslations: async () => (key: string) => key,
}));

const BASE64_NONCE = /^[A-Za-z0-9+/]{22}==$/;

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split('; ').map((entry) => {
      const at = entry.indexOf(' ');
      return [entry.slice(0, at), entry.slice(at + 1)];
    })
  );
}

function pageRequest(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

function nonceOf(csp: string): string {
  const match = /'nonce-([^']+)'/.exec(csp);
  expect(match, csp).not.toBeNull();
  return match![1];
}

describe('the page policy', () => {
  it('allows scripts by nonce and strict-dynamic, never by unsafe-inline', () => {
    const nonce = generatePageNonce();
    const script = directives(buildPageCsp(nonce, false)).get('script-src');

    expect(script).toBe(
      `'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' blob: https://cdn.paddle.com https://*.paddle.com`
    );
    expect(script).not.toContain('unsafe-inline');
    expect(script?.split(' ')).not.toContain("'unsafe-eval'");
  });

  it('keeps the fixed directives of the page policy', () => {
    const policy = directives(buildPageCsp('abc', false));

    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'self'");
    expect(policy.get('form-action')).toBe("'self'");
    expect(policy.get('frame-ancestors')).toBe("'self'");
    expect(policy.get('frame-src')).toBe("'self' https://*.paddle.com");
    expect(policy.get('worker-src')).toBe("'self' blob:");
    expect(policy.get('connect-src')).toBe("'self' blob: https://*.paddle.com");
    // React writes style="" attributes, which a nonce cannot allow (src/lib/security/page-csp.ts).
    expect(policy.get('style-src')).toBe("'self' 'unsafe-inline' https://cdn.paddle.com https://*.paddle.com");
  });

  it('permits unsafe-eval and the hot reload websocket only for the development server', () => {
    const dev = directives(buildPageCsp('abc', true));

    expect(dev.get('script-src')?.split(' ')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toBe("'self' ws: wss: blob: https://*.paddle.com");
    expect(directives(buildPageCsp('abc', false)).get('script-src')?.split(' ')).not.toContain("'unsafe-eval'");
  });

  it('makes a 128-bit base64 nonce that differs on every call', () => {
    const nonces = new Set(Array.from({ length: 200 }, generatePageNonce));

    expect(nonces.size).toBe(200);
    for (const nonce of nonces) expect(nonce).toMatch(BASE64_NONCE);
  });
});

describe('the middleware on a page request', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['/', '/ko', '/terms', '/ko/pdf-to-jpg', '/pdf-to-jpg', '/api-docs', '/auth', '/does-not-exist', '/en/terms'])(
    'sets the policy on the answer for %s, redirects and not-found paths included',
    (path) => {
      const response = middleware(pageRequest(path, { 'accept-language': 'en' })) as Response;
      const csp = response.headers.get('content-security-policy') ?? '';

      expect(nonceOf(csp)).toMatch(BASE64_NONCE);
      expect(directives(csp).get('script-src')).not.toContain('unsafe-inline');
    }
  );

  it.each(['/', '/ko', '/terms', '/ko/pdf-to-jpg'])(
    'hands the nonce and the same policy to the render of %s as request headers',
    (path) => {
      const response = middleware(pageRequest(path, { 'accept-language': 'en' })) as Response;
      const csp = response.headers.get('content-security-policy') ?? '';

      expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
      expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonceOf(csp));
      const overridden = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
      expect(overridden).toEqual(expect.arrayContaining(['content-security-policy', 'x-nonce']));
    }
  );

  it('makes a new nonce for every request', () => {
    const first = (middleware(pageRequest('/terms')) as Response).headers.get('content-security-policy') ?? '';
    const second = (middleware(pageRequest('/terms')) as Response).headers.get('content-security-policy') ?? '';

    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it('replaces a nonce or a policy the client sent', () => {
    const response = middleware(
      pageRequest('/terms', { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'unsafe-inline'" })
    ) as Response;
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonceOf(csp));
    expect(response.headers.get('x-middleware-request-x-nonce')).not.toBe('attacker');
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('keeps the page answer as it was: the language rewrite, and no store of the root', () => {
    const terms = middleware(pageRequest('/terms')) as Response;
    const root = middleware(pageRequest('/', { 'accept-language': 'ko' })) as Response;

    expect(terms.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/en/terms');
    expect(root.headers.get('cache-control')).toBe('private, no-store');
  });

  it('puts no page policy on an API answer', () => {
    vi.stubEnv('TRUSTED_PROXIES', 'none');
    const response = middleware(pageRequest('/api/v1/formats')) as Response;

    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('allows unsafe-eval in the policy only when the server runs in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const dev = (middleware(pageRequest('/terms')) as Response).headers.get('content-security-policy') ?? '';
    vi.stubEnv('NODE_ENV', 'production');
    const prod = (middleware(pageRequest('/terms')) as Response).headers.get('content-security-policy') ?? '';

    const hosts = 'blob: https://cdn.paddle.com https://*.paddle.com';
    expect(directives(dev).get('script-src')).toBe(`'self' 'nonce-${nonceOf(dev)}' 'strict-dynamic' 'wasm-unsafe-eval' 'unsafe-eval' ${hosts}`);
    expect(directives(prod).get('script-src')).toBe(`'self' 'nonce-${nonceOf(prod)}' 'strict-dynamic' 'wasm-unsafe-eval' ${hosts}`);
  });
});

describe('the locale layout', () => {
  function scriptsOf(node: ReactNode, found: ReactElement<{ nonce?: string }>[] = []): ReactElement<{ nonce?: string }>[] {
    if (Array.isArray(node)) node.forEach((child) => scriptsOf(child, found));
    else if (isValidElement<{ children?: ReactNode; nonce?: string }>(node)) {
      if (node.type === 'script') found.push(node as ReactElement<{ nonce?: string }>);
      scriptsOf(node.props.children, found);
    }
    return found;
  }

  it.each(['abc123==', 'Zm9v'])('puts the nonce %s of the request on both inline scripts of the head', async (nonce) => {
    request.nonce = nonce;
    const { default: LocaleLayout } = await import('../src/app/[locale]/layout');
    const tree = await LocaleLayout({ params: Promise.resolve({ locale: 'en' }), children: null });
    const scripts = scriptsOf(tree);

    expect(scripts).toHaveLength(2);
    for (const script of scripts) expect(script.props.nonce).toBe(nonce);
  });

  it('puts no nonce attribute on a request that has none, as a test render has', async () => {
    request.nonce = null;
    const { default: LocaleLayout } = await import('../src/app/[locale]/layout');
    const scripts = scriptsOf(await LocaleLayout({ params: Promise.resolve({ locale: 'en' }), children: null }));

    expect(scripts).toHaveLength(2);
    for (const script of scripts) expect(script.props.nonce).toBeUndefined();
  });
});

describe('the page header names', () => {
  it('uses x-nonce, the name the layout reads', () => {
    expect(PAGE_NONCE_HEADER).toBe('x-nonce');
  });
});
