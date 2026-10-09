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
  // PDF export (src/lib/export/pdf.ts) launches Chromium: keep both packages
  // out of the bundle so the brotli-packed binary and puppeteer's dynamic
  // requires load from node_modules at run time.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    "/api/documents/[id]/export": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com", pathname: "/**" },
    ],
  },
};

export default nextConfig;
