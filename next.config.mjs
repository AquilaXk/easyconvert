/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracing: false,
  experimental: {
    serverComponentsExternalPackages: ['sharp', 'pdfkit'],
  },
};

export default nextConfig;
