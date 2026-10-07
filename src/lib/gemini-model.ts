// Single source of truth for the Gemini model id used across extraction and the
// structured subject-info pull. Google retires model versions on a schedule
// (gemini-2.0-flash and -flash-lite were shut down 2026-06-01), so keep this on a
// current GA "flash" workhorse and override with the GEMINI_MODEL env var — no
// code change needed — when the next version lands or if a key lacks this one.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
