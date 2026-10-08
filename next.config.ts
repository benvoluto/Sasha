import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile in a parent directory makes Next guess the wrong
  // workspace root; pin it to this project.
  turbopack: { root: path.resolve(__dirname) },
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
