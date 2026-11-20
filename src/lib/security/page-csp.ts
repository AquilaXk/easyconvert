/**
 * The Content-Security-Policy of a page answer, with a nonce made for that one request (docs/policy-decisions.md, entry 370).
 *
 * The shape follows the Next.js guide "Content Security Policy" and its example `with-strict-csp` (vercel/next.js, MIT,
 * examples/with-strict-csp at 9d3069adc7bf): the middleware makes the nonce, puts the policy on the request, where Next.js
 * reads it back while it renders and stamps the nonce on its own inline scripts and on the script tags it emits, and on the
 * response. Our two inline scripts of the layout read the nonce from the `x-nonce` request header. `'strict-dynamic'` hands
 * the trust of a nonced script to the scripts it loads (the webpack chunks, the checkout script of the payment provider), as
 * in the guide; `'self'`, `blob:` and the hosts after it are what a browser without `'strict-dynamic'` falls back to, and
 * which browsers that know it ignore. `style-src` keeps `'unsafe-inline'`: React writes `style=""` attributes, which a
 * nonce or a hash cannot allow, and a nonce in `style-src` would make a browser ignore `'unsafe-inline'`.
 */

export const PAGE_NONCE_HEADER = 'x-nonce';

const NONCE_BYTES = 16;

/** 128 random bits from the platform generator, base64 as the guide has it: unique per request and not guessable. */
export function generatePageNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return btoa(String.fromCharCode(...bytes));
}

export function buildPageCsp(nonce: string, isDevServer: boolean): string {
  // React's debugging in the development server rebuilds server stacks with eval, and its hot reload talks over a websocket.
  const devScript = isDevServer ? " 'unsafe-eval'" : '';
  const devConnect = isDevServer ? ' ws: wss:' : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${devScript} blob: https://cdn.paddle.com https://*.paddle.com`,
    "style-src 'self' 'unsafe-inline' https://cdn.paddle.com https://*.paddle.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${devConnect} blob: https://*.paddle.com`,
    "worker-src 'self' blob:",
    "child-src 'self' blob: https://*.paddle.com",
    "frame-src 'self' https://*.paddle.com",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
