// `npm run catalog:build` — validate src/catalog/types/*.json and regenerate
// catalog.bundle.json and catalog.index.json. `npm run catalog:build -- --check`
// (CI) validates and fails if the generated files are stale. The logic lives in
// ./catalog-build.ts.

import { fileURLToPath } from "node:url";
import { catalogPaths, runCatalogBuild } from "./catalog-build";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { code, lines } = runCatalogBuild(catalogPaths(root), { check: process.argv.includes("--check") });
for (const line of lines) (code ? console.error : console.log)(line);
process.exit(code);
