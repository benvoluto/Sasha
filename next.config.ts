import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The icon package is a ~3000-export barrel. Without this, importing a
  // handful of icons pulls the whole barrel into the module graph; this
  // rewrites them to per-icon deep imports.
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com", pathname: "/**" },
    ],
  },
};

export default nextConfig;
