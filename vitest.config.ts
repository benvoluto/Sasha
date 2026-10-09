import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Mirrors the `@/*` path alias in tsconfig.json so modules that import through
// it (e.g. the eligibility core, which reads prompt-defaults) can be tested.
// The Playwright specs under e2e/ (*.spec.ts) run with `npm run test:e2e`, not here.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", "playwright-report/**", "test-results/**"],
  },
});
