import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    middlewareClientMaxBodySize: "10mb",
  },
  output: "standalone",
};

export default nextConfig;
