import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors the `@/*` path alias in tsconfig.json so modules that import through
// it (e.g. the eligibility core, which reads prompt-defaults) can be tested.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
