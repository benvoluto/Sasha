// Phase 9 rate limits: the shared contract (phase9-spec.md §2). Every route that
// spends model money reserves one call in a task family before the call, for
// the caller (per user) and for their team (per team). Each family has its own
// windows, so a burst of cheap background Haiku calls never eats into drafting.
//
// The limiter itself is src/lib/limits/limiter.ts (Postgres `model_call` under
// an advisory lock across instances, process memory without POSTGRES_URL).
// This file holds only the types, the defaults and the 429 body, so client
// code can import it.

/** Families of model work, cheapest first. */
export const LIMIT_FAMILIES = ["light", "check", "draft", "ingest", "workflow", "learn", "export"] as const;
export type LimitFamily = (typeof LIMIT_FAMILIES)[number];

/** What each family covers (shown in the spec and in the 429 message). */
export const FAMILY_NOUN: Record<LimitFamily, { one: string; many: string }> = {
  /** Background Haiku: classify.type, outline.status, suggest.items. */
  light: { one: "background check", many: "background checks" },
  /** rubric.check (Sonnet). */
  check: { one: "rubric check", many: "rubric checks" },
  /** Section generate and selection rewrite (Opus). */
  draft: { one: "draft", many: "drafts" },
  /** Reading sources: Gemini extraction and tables, summarize.source. Counted per file. */
  ingest: { one: "source read", many: "source reads" },
  /** Workflow starts and failed-run retries (Sonnet/Opus and web search, in after()); going on from a pause or checkpoint is free. */
  workflow: { one: "workflow run", many: "workflow runs" },
  /** learn.extract (Opus, streamed). */
  learn: { one: "learning run", many: "learning runs" },
  /** PDF export (puppeteer; no model, but heavy). */
  export: { one: "PDF export", many: "PDF exports" },
};

export type LimitWindow = { limit: number; windowMs: number };
export type FamilyLimits = { user: LimitWindow[]; team: LimitWindow[] };

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Defaults. Override per deployment with SASHA_LIMIT_<FAMILY>_<USER|TEAM>, a
 * comma list of `<limit>/<window>` where the window is `<n>s|m|h|d`, e.g.
 * SASHA_LIMIT_DRAFT_USER="30/1h,150/1d". "off" disables that side.
 * The team side of `check` (40/h) and `learn` (6/h) keep the Phase 7 and 8 caps.
 */
export const DEFAULT_LIMITS: Record<LimitFamily, FamilyLimits> = {
  // Sized from the background cadences (cadence.test.ts): outline status every 30 s while typing (~120/h),
  // classify every 2 min, suggestions at most 1/min. A full day of writing in two documents fits.
  light: { user: [{ limit: 120, windowMs: 10 * MIN }, { limit: 3000, windowMs: DAY }], team: [{ limit: 15000, windowMs: DAY }] },
  check: { user: [{ limit: 20, windowMs: HOUR }], team: [{ limit: 40, windowMs: HOUR }] },
  draft: { user: [{ limit: 30, windowMs: HOUR }, { limit: 150, windowMs: DAY }], team: [{ limit: 600, windowMs: DAY }] },
  ingest: { user: [{ limit: 60, windowMs: HOUR }, { limit: 300, windowMs: DAY }], team: [{ limit: 1000, windowMs: DAY }] },
  workflow: { user: [{ limit: 10, windowMs: HOUR }, { limit: 40, windowMs: DAY }], team: [{ limit: 200, windowMs: DAY }] },
  learn: { user: [{ limit: 4, windowMs: HOUR }], team: [{ limit: 6, windowMs: HOUR }] },
  export: { user: [{ limit: 20, windowMs: 10 * MIN }], team: [{ limit: 200, windowMs: HOUR }] },
};

/** Who is reserving: from requireTeam's TeamCaller. */
export type LimitSubject = { userId: string; teamId: string };

/** A raw counter: `key` is a bucket name, e.g. `user:<userId>:draft:3600000` or `doc:<id>:outline`. */
export type LimitBucket = { key: string; limit: number; windowMs: number };

export type LimitRefusal = {
  ok: false;
  /** Which side ran out ("key" for a raw bucket such as a per-document interval). */
  scope: "user" | "team" | "key";
  family: LimitFamily | null;
  limit: number;
  windowMs: number;
  retryAfterSeconds: number;
};
export type LimitDecision = { ok: true } | LimitRefusal;

/** The 429 body every limited route returns (with a Retry-After header in seconds). */
export type RateLimitedBody = {
  /** Plain sentence the UI shows as is, e.g. "You've used your 30 drafts for this hour. Try again in 12 min." */
  error: string;
  code: "rate_limited";
  scope: LimitRefusal["scope"];
  family: LimitFamily | null;
  retry_after_seconds: number;
};

export function isRateLimitedBody(body: unknown): body is RateLimitedBody {
  return !!body && typeof body === "object" && (body as { code?: unknown }).code === "rate_limited";
}
