/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracing: false,
  // Next 15 loads src/instrumentation.ts at server start without a flag, so storage misconfiguration stops the server.
  serverExternalPackages: ['sharp', 'pdfkit'],
};

export default nextConfig;
