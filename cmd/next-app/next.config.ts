import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    allowedDevOrigins: [
      "localhost:5173",
      "entodermal-unswatheable-diana.ngrok-free.dev"
    ]
  }
};

export default nextConfig;
