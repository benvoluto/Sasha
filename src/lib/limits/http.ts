// The 429 every limited route returns (phase9-spec.md §2.2): a Retry-After
// header in seconds and a RateLimitedBody whose `error` is a plain sentence
// the UI shows as is.

import { NextResponse } from "next/server";
import { FAMILY_NOUN, type LimitFamily, type LimitRefusal, type RateLimitedBody } from "./contract";
import { checkModelCall, reserveModelCall } from "./limiter";
import { ModelCallLimitedError } from "./reserve";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "this hour", "today", "the last 10 minutes", "the last minute". */
export function windowPhrase(windowMs: number): string {
  if (windowMs === HOUR) return "this hour";
  if (windowMs === DAY) return "today";
  const last = (n: number, word: string) => (n === 1 ? `the last ${word}` : `the last ${plural(n, word)}`);
  if (windowMs % DAY === 0) return last(windowMs / DAY, "day");
  if (windowMs % HOUR === 0) return last(windowMs / HOUR, "hour");
  if (windowMs % MINUTE === 0) return last(windowMs / MINUTE, "minute");
  return last(Math.max(1, Math.round(windowMs / 1000)), "second");
}

/** "45s" under a minute, "12 min" under two hours, else "3 h". */
export function waitPhrase(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  if (s < 7200) return `${Math.ceil(s / 60)} min`;
  return `${Math.ceil(s / 3600)} h`;
}

/**
 * The plain sentence for a refusal. A "key" bucket (a per-document interval)
 * has no family noun to name, so its caller passes its own message; without
 * one it only says when to try again.
 */
export function rateLimitMessage(refusal: LimitRefusal): string {
  const wait = `Try again in ${waitPhrase(refusal.retryAfterSeconds)}.`;
  if (refusal.scope === "key" || !refusal.family) return wait;
  const noun = FAMILY_NOUN[refusal.family];
  const what = `${refusal.limit} ${refusal.limit === 1 ? noun.one : noun.many} for ${windowPhrase(refusal.windowMs)}`;
  return refusal.scope === "user" ? `You've used your ${what}. ${wait}` : `Your team has used its ${what}. ${wait}`;
}

export type RateLimitedOptions = {
  /** Overrides rateLimitMessage (per-document intervals). */
  message?: string;
  /** Extra body fields kept for older clients (e.g. `retryAfterSeconds`). */
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
};

/** 429 with Retry-After and a RateLimitedBody. */
export function rateLimitedResponse(refusal: LimitRefusal, opts: RateLimitedOptions = {}): NextResponse {
  const body: RateLimitedBody = {
    error: opts.message ?? rateLimitMessage(refusal),
    code: "rate_limited",
    scope: refusal.scope,
    family: refusal.family,
    retry_after_seconds: refusal.retryAfterSeconds,
  };
  return NextResponse.json({ ...opts.extra, ...body }, { status: 429, headers: { ...opts.headers, "Retry-After": String(refusal.retryAfterSeconds) } });
}

/**
 * Reserve `cost` calls of the family for the caller's user and team windows:
 * null when allowed (and counted), else the ready 429. Call it after the
 * checks that need no model, right before the model work.
 */
export async function limitModelCall(caller: { userId: string; teamId: string }, family: LimitFamily, opts: { cost?: number; now?: number } & RateLimitedOptions = {}): Promise<NextResponse | null> {
  const decision = await reserveModelCall({ userId: caller.userId, teamId: caller.teamId }, family, { cost: opts.cost, now: opts.now });
  return decision.ok ? null : rateLimitedResponse(decision, opts);
}

/**
 * limitModelCall's pre-check: null when `cost` calls would fit, else the ready
 * 429, recording nothing either way. For a step that comes before the charged
 * one (presign before complete), so a refusal arrives before the work does.
 */
export async function checkModelCallLimit(caller: { userId: string; teamId: string }, family: LimitFamily, opts: { cost?: number; now?: number } & RateLimitedOptions = {}): Promise<NextResponse | null> {
  const decision = await checkModelCall({ userId: caller.userId, teamId: caller.teamId }, family, { cost: opts.cost, now: opts.now });
  return decision.ok ? null : rateLimitedResponse(decision, opts);
}

/** The 429 for a ModelCallLimitedError thrown by library code, or null for any other error. */
export function limitedErrorResponse(error: unknown): NextResponse | null {
  return error instanceof ModelCallLimitedError ? rateLimitedResponse(error.refusal, { message: error.userMessage }) : null;
}
