import { beforeEach, describe, expect, it } from "vitest";
import type { LimitRefusal } from "./contract";
import { limitedErrorResponse, limitModelCall, rateLimitedResponse, rateLimitMessage, waitPhrase, windowPhrase } from "./http";
import { resetLimiter } from "./limiter";
import { ModelCallLimitedError, reserveOrThrow } from "./reserve";
import { retryAfterMs } from "./client";

const refusal = (over: Partial<LimitRefusal> = {}): LimitRefusal => ({ ok: false, scope: "user", family: "draft", limit: 30, windowMs: 3_600_000, retryAfterSeconds: 720, ...over });

describe("rateLimitMessage", () => {
  it("speaks to the user or the team, naming the family and the window", () => {
    expect(rateLimitMessage(refusal())).toBe("You've used your 30 drafts for this hour. Try again in 12 min.");
    expect(rateLimitMessage(refusal({ scope: "team", family: "check", limit: 40 }))).toBe("Your team has used its 40 rubric checks for this hour. Try again in 12 min.");
    expect(rateLimitMessage(refusal({ family: "light", limit: 60, windowMs: 600_000, retryAfterSeconds: 45 }))).toBe("You've used your 60 background checks for the last 10 minutes. Try again in 45s.");
    expect(rateLimitMessage(refusal({ scope: "team", family: "ingest", limit: 1000, windowMs: 86_400_000, retryAfterSeconds: 3 * 3600 + 1 }))).toBe(
      "Your team has used its 1000 source reads for today. Try again in 4 h.",
    );
    expect(rateLimitMessage(refusal({ family: "export", limit: 1, windowMs: 60_000, retryAfterSeconds: 30 }))).toBe("You've used your 1 PDF export for the last minute. Try again in 30s.");
  });

  it("a key bucket only says when to try again", () => {
    expect(rateLimitMessage(refusal({ scope: "key", family: null, retryAfterSeconds: 15 }))).toBe("Try again in 15s.");
  });

  it("phrases windows and waits", () => {
    expect(windowPhrase(2 * 86_400_000)).toBe("the last 2 days");
    expect(windowPhrase(6 * 3_600_000)).toBe("the last 6 hours");
    expect(windowPhrase(30_000)).toBe("the last 30 seconds");
    expect(waitPhrase(0)).toBe("1s");
    expect(waitPhrase(59)).toBe("59s");
    expect(waitPhrase(60)).toBe("1 min");
    expect(waitPhrase(7199)).toBe("120 min");
    expect(waitPhrase(7200)).toBe("2 h");
  });
});

describe("rateLimitedResponse", () => {
  it("is a 429 with Retry-After and a RateLimitedBody", async () => {
    const res = rateLimitedResponse(refusal());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("720");
    expect(await res.json()).toEqual({ error: "You've used your 30 drafts for this hour. Try again in 12 min.", code: "rate_limited", scope: "user", family: "draft", retry_after_seconds: 720 });
  });

  it("takes a caller's message, extra fields and headers, never letting them replace the contract fields", async () => {
    const res = rateLimitedResponse(refusal({ scope: "key", retryAfterSeconds: 9 }), { message: "Checked moments ago.", extra: { retryAfterSeconds: 9, code: "nope" }, headers: { "Cache-Control": "no-store", "Retry-After": "1" } });
    expect(res.headers.get("Retry-After")).toBe("9");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "Checked moments ago.", code: "rate_limited", scope: "key", retryAfterSeconds: 9 });
  });
});

describe("limitModelCall and library refusals", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetLimiter();
  });

  it("returns null while allowed, then the 429", async () => {
    const caller = { userId: "u1", teamId: "org:a" };
    for (let i = 0; i < 4; i++) expect(await limitModelCall(caller, "learn")).toBeNull();
    const res = await limitModelCall(caller, "learn");
    expect(res?.status).toBe(429);
    expect(await res!.json()).toMatchObject({ code: "rate_limited", scope: "user", family: "learn" });
  });

  it("reserveOrThrow throws ModelCallLimitedError, which limitedErrorResponse turns into the 429", async () => {
    const subject = { userId: "u1", teamId: "org:a" };
    await reserveOrThrow(null, "learn");
    for (let i = 0; i < 4; i++) await reserveOrThrow(subject, "learn");
    const error = await reserveOrThrow(subject, "learn").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallLimitedError);
    expect(limitedErrorResponse(error)?.status).toBe(429);
    expect(limitedErrorResponse(new Error("other"))).toBeNull();
    const keyed = limitedErrorResponse(new ModelCallLimitedError(refusal({ scope: "key", family: "light", retryAfterSeconds: 5 }), "The outline was checked moments ago."));
    expect((await keyed!.json()).error).toBe("The outline was checked moments ago.");
  });
});

describe("retryAfterMs (client)", () => {
  it("reads the body, then the header, then the fallback, only for a 429", () => {
    const body = { error: "x", code: "rate_limited", scope: "user", family: "light", retry_after_seconds: 12 };
    expect(retryAfterMs(429, body, "99")).toBe(12_000);
    expect(retryAfterMs(429, { error: "x" }, "7")).toBe(7000);
    expect(retryAfterMs(429, null, null, 5000)).toBe(5000);
    expect(retryAfterMs(200, body, "7")).toBeNull();
  });
});
