import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
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
  // Disable font optimization in CI to avoid fetch errors
  // @ts-expect-error: optimizeFonts is valid but missing in NextConfig type definition in some versions
  optimizeFonts: !process.env.CI,
};

export default nextConfig;

// Forced reload timestamp: 1

