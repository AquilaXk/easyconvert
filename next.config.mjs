import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } from 'next/constants.js';

function pageContentSecurityPolicy(isDevServer) {
  const devScript = isDevServer ? " 'unsafe-eval'" : '';
  const devConnect = isDevServer ? ' ws: wss:' : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${devScript} blob: https://cdn.paddle.com https://*.paddle.com`,
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

/** @type {(isDevServer: boolean) => import('next').NextConfig} */
function buildNextConfig(isDevServer) {
  const csp = pageContentSecurityPolicy(isDevServer);
  return {
    reactStrictMode: true,
    outputFileTracing: false,
    // Next 15 loads src/instrumentation.ts at server start without a flag, so storage misconfiguration stops the server.
    // harfbuzzjs loads its WebAssembly module from beside its own files, so it must not be bundled. tesseract.js starts its
    // worker from a path beside its own files too (src/worker-script/node): bundled, that path points into .next and the
    // OCR worker never starts, so every OCR conversion of the web server waited 60 s and answered 503.
    serverExternalPackages: ['sharp', 'pdfkit', 'harfbuzzjs', 'tesseract.js', 'onnxruntime-node'],
    experimental: {
      // The middleware matches every /api route, and Next.js hands a route only the first 10 MiB of a body that the
      // middleware could read (it ends the body there without an error), so a file past 10 MiB reached no route whole.
      // This is SINGLE_REQUEST_BODY_MAX_BYTES of src/lib/plan-limits.ts (65 MiB: the largest single request, which is
      // also a part of an upload in parts and its framing); tests/next-config-body-limit.test.ts holds the two together.
      middlewareClientMaxBodySize: 65 * 1024 * 1024,
    },
    async headers() {
      return [
        {
          source: '/((?!api/|_assets/).*)',
          headers: [
            { key: 'Content-Security-Policy', value: csp },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
            { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' },
          ],
        },
      ];
    },
    async rewrites() {
      return [
        {
          source: '/_assets/ocr/:version/:asset+',
          destination: '/api/ocr-assets/:version/:asset+',
        },
      ];
    },
  };
}

/** The legal pages import their Markdown from docs/legal as text (`?raw`, src/lib/legal/texts.ts), as Vite does in the tests. */
function importMarkdownAsText(webpackConfig) {
  webpackConfig.module.rules.push({ resourceQuery: /^\?raw$/, type: 'asset/source' });
  return webpackConfig;
}

// The i18n plugin only wires the request config into the build, and loading it loads a native compiler that unpacks itself
// into an executable cache, which the production container (read-only root, noexec tmpfs) does not have. `next start`
// serves the built output, so the server phase takes the plain config (tests/next-config-runtime-phase.test.ts).
const prodConfig = buildNextConfig(false);
const devConfig = buildNextConfig(true);

export default async function config(phase) {
  const nextConfig = phase === PHASE_DEVELOPMENT_SERVER ? devConfig : prodConfig;
  if (phase === PHASE_PRODUCTION_SERVER) return nextConfig;
  const { default: createNextIntlPlugin } = await import('next-intl/plugin');
  return createNextIntlPlugin()({ ...nextConfig, webpack: importMarkdownAsText });
}
