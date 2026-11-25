import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ['entodermal-unswatheable-diana.ngrok-free.dev'],

  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      // OAuth consent: a signed-in user is one click from granting access, so no
      // other site may frame these pages (clickjacking). X-Frame-Options covers
      // browsers that predate CSP frame-ancestors.
      {
        source: '/oauth/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
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
