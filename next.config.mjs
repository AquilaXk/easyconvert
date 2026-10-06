/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracing: false,
  serverExternalPackages: ['sharp', 'pdfkit'],
};

export default nextConfig;
