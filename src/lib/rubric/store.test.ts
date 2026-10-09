import { beforeEach, describe, expect, it } from "vitest";
import { resetMemoryStore } from "@/lib/documents/store";
import { CHECK_MIN_INTERVAL_MS, CHECK_TEAM_HOURLY_LIMIT, type RubricCheckResponse } from "./contract";
import { checkScopeKey, getStoredCheck, intervalGate, recentModelChecks, reserveModelCheck, recordModelCheck, saveCheck } from "./store";

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

  it("the hourly limit counts the team's model checks over a rolling hour", async () => {
    const t0 = Date.parse("2026-10-08T10:00:00.000Z");
    for (let i = 0; i < CHECK_TEAM_HOURLY_LIMIT; i++) await recordModelCheck(A, t0 + i * 1000);
    await recordModelCheck(B, t0);
    expect(await recentModelChecks(A, t0 + 60_000)).toEqual({ count: CHECK_TEAM_HOURLY_LIMIT, oldest: t0 });
    const blocked = await reserveModelCheck(A, null, "h", t0 + 60_000);
    expect(blocked).toEqual({ ok: false, reason: "hourly", retryAfterSeconds: 3600 - 60 });
    expect(await reserveModelCheck(B, null, "h", t0 + 60_000)).toEqual({ ok: true });
    // An hour after the first call it has dropped out of the window.
    expect(await reserveModelCheck(A, null, "h", t0 + 3_600_000)).toEqual({ ok: true });
  });

  it("reserves and counts in one step, so a burst of parallel checks stops at the limit", async () => {
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => reserveModelCheck(A, null, `h${i}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(CHECK_TEAM_HOURLY_LIMIT);
    expect(results.filter((r) => !r.ok && r.reason === "hourly")).toHaveLength(200 - CHECK_TEAM_HOURLY_LIMIT);
    expect((await recentModelChecks(A)).count).toBe(CHECK_TEAM_HOURLY_LIMIT);
  });
});
