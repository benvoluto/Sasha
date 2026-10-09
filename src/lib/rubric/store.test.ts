import { beforeEach, describe, expect, it } from "vitest";
import { resetMemoryStore } from "@/lib/documents/store";
import { DEFAULT_LIMITS } from "@/lib/limits/contract";
import { CHECK_MIN_INTERVAL_MS, CHECK_TEAM_HOURLY_LIMIT, type RubricCheckResponse } from "./contract";
import { checkScopeKey, getStoredCheck, intervalGate, saveCheck } from "./store";

const A = "org:a";
const B = "org:b";
const DOC = "11111111-1111-4111-8111-111111111111";
const result = (hash: string): RubricCheckResponse => ({ scope: "document", sectionId: null, typeKey: null, typeVersion: null, inputsHash: hash, cached: false, checkedAt: "2026-10-08T00:00:00.000Z", sectionFingerprints: {}, results: [], droppedEvidence: 0 });

describe("rubric check store", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("keeps one result per team, document and scope", async () => {
    expect(checkScopeKey(null)).toBe("doc");
    expect(checkScopeKey("s_1")).toBe("section:s_1");
    await saveCheck(A, DOC, "doc", "h1", result("h1"));
    await saveCheck(A, DOC, "section:s_1", "h2", result("h2"));
    expect((await getStoredCheck(A, DOC, "doc"))!.inputsHash).toBe("h1");
    expect((await getStoredCheck(A, DOC, "section:s_1"))!.result.inputsHash).toBe("h2");
    // Another team never sees it.
    expect(await getStoredCheck(B, DOC, "doc")).toBeNull();
    await saveCheck(A, DOC, "doc", "h3", result("h3"));
    expect((await getStoredCheck(A, DOC, "doc"))!.inputsHash).toBe("h3");
  });

  it("the interval: the same inputs wait, changed inputs never do", () => {
    const now = Date.parse("2026-10-08T00:00:10.000Z");
    const last = { inputsHash: "h1", createdAt: "2026-10-08T00:00:00.000Z" };
    expect(intervalGate(null, "h1", now)).toEqual({ ok: true });
    expect(intervalGate(last, "h2", now)).toEqual({ ok: true });
    expect(intervalGate(last, "h1", now)).toEqual({ ok: false, reason: "interval", retryAfterSeconds: Math.ceil((CHECK_MIN_INTERVAL_MS - 10_000) / 1000) });
    expect(intervalGate(last, "h1", Date.parse(last.createdAt) + CHECK_MIN_INTERVAL_MS)).toEqual({ ok: true });
  });

  it("the team's hourly cap is the limiter's default team window for checks", () => {
    expect(DEFAULT_LIMITS.check.team).toEqual([{ limit: CHECK_TEAM_HOURLY_LIMIT, windowMs: 3_600_000 }]);
  });
});
