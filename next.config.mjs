import { PHASE_PRODUCTION_SERVER } from 'next/constants.js';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracing: false,
  // Next 15 loads src/instrumentation.ts at server start without a flag, so storage misconfiguration stops the server.
  // harfbuzzjs loads its WebAssembly module from beside its own files, so it must not be bundled.
  serverExternalPackages: ['sharp', 'pdfkit', 'harfbuzzjs'],
  experimental: {
    // The middleware matches every /api route, and Next.js hands a route only the first 10 MiB of a body that the
    // middleware could read (it ends the body there without an error), so a file past 10 MiB reached no route whole.
    // This is SINGLE_REQUEST_BODY_MAX_BYTES of src/lib/plan-limits.ts (65 MiB: the largest single request, which is
    // also a part of an upload in parts and its framing); tests/next-config-body-limit.test.ts holds the two together.
    middlewareClientMaxBodySize: 65 * 1024 * 1024,
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

/** The legal pages import their Markdown from docs/legal as text (`?raw`, src/lib/legal/texts.ts), as Vite does in the tests. */
function importMarkdownAsText(webpackConfig) {
  webpackConfig.module.rules.push({ resourceQuery: /^\?raw$/, type: 'asset/source' });
  return webpackConfig;
}

// The i18n plugin only wires the request config into the build, and loading it loads a native compiler that unpacks itself
// into an executable cache, which the production container (read-only root, noexec tmpfs) does not have. `next start`
// serves the built output, so the server phase takes the plain config (tests/next-config-runtime-phase.test.ts).
export default async function config(phase) {
  if (phase === PHASE_PRODUCTION_SERVER) return nextConfig;
  const { default: createNextIntlPlugin } = await import('next-intl/plugin');
  return createNextIntlPlugin()({ ...nextConfig, webpack: importMarkdownAsText });
}
