/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracing: false,
  // Next 15 loads src/instrumentation.ts at server start without a flag, so storage misconfiguration stops the server.
  // harfbuzzjs loads its WebAssembly module from beside its own files, so it must not be bundled.
  serverExternalPackages: ['sharp', 'pdfkit', 'harfbuzzjs'],
};

export default nextConfig;
