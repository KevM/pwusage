import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  experimental: {
    allowedDevOrigins: [
      "localhost:5173",
      "entodermal-unswatheable-diana.ngrok-free.dev"
    ]
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

