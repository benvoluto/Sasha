import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Playwright web server (playwright.config.ts) builds into its own
  // directory so it can run beside a normal `npm run dev` without the two
  // overwriting each other's .next. Next insists that the tsconfig it reads
  // includes `<distDir>/types`, and rewrites the file when it doesn't, so that
  // run reads e2e/tsconfig.next.json (which lists .next-e2e) and the root
  // tsconfig.json is left alone. Both unset everywhere else.
  ...(process.env.SASHA_NEXT_DIST_DIR
    ? { distDir: process.env.SASHA_NEXT_DIST_DIR, typescript: { tsconfigPath: "e2e/tsconfig.next.json" } }
    : {}),
  // e2e runs (playwright.config.ts): no "N" dev badge over the rail in
  // screenshots and axe scans. Build errors still open the overlay.
  ...(process.env.SASHA_E2E_STUB_MODELS === "1" ? { devIndicators: false as const } : {}),
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
