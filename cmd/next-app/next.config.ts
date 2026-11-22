import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ['entodermal-unswatheable-diana.ngrok-free.dev'],

  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async redirects() {
    return [
      // The TRMNL page moved from /help/trmnl; the plugin listing on trmnl.com still links there.
      { source: '/help/trmnl', destination: '/trmnl', permanent: true },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'vehicle-files.prd.usw2.vn.cloud.tesla.com',
        port: '',
        pathname: '/profile_images/**',
      },
    ],
  },
};

export default nextConfig;

// Forced reload timestamp: 1
