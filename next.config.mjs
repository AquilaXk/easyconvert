/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracing: false,
  experimental: {
    serverComponentsExternalPackages: ['sharp', 'pdfkit'],
    // Loads src/instrumentation.ts at server start so storage misconfiguration stops the server.
    instrumentationHook: true,
  },
};

export default nextConfig;
