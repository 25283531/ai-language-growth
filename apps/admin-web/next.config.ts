import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const backend = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:3100';
    return [{ source: '/api/v1/:path*', destination: `${backend}/api/v1/:path*` }];
  },
};
export default nextConfig;
