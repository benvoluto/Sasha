// End-to-end test mode (phase9-spec.md §4.1). The Playwright web server starts
// `next dev` with these flags so no test ever reaches a paid API or the real
// Blob store. Both are ignored in production builds, like the dev auth bypass,
// so a stray env var on a deployment changes nothing.
//
//   SASHA_E2E_STUB_MODELS=1  Claude (claude.ts, call.ts) and Gemini (extraction,
//                            tables) return deterministic fixtures from
//                            src/lib/e2e/stub-models.ts. claudeConfigured() is true.
//   SASHA_E2E_STUB_BLOB=1    Uploads land in process memory (src/lib/e2e/blob-store.ts)
//                            through /api/e2e/blob; downloads and head() read it.

const notProduction = () => process.env.NODE_ENV !== "production";

export function e2eStubModels(): boolean {
  return notProduction() && process.env.SASHA_E2E_STUB_MODELS === "1";
}

export function e2eStubBlob(): boolean {
  return notProduction() && process.env.SASHA_E2E_STUB_BLOB === "1";
}
