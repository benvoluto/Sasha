import { beforeEach, describe, expect, it } from "vitest";
import { nextRefreshDelay } from "@/components/editor/use-outline-status";
import { CLASSIFY_MIN_INTERVAL_MS } from "@/lib/classifier/contract";
import { MIN_GENERATE_INTERVAL_MS } from "@/lib/suggestions/generate";
import { reserveModelCall, resetLimiter } from "./limiter";

// The light defaults against the background hooks' real cadences, worst case:
// saves never stop, so outline status runs as often as the hook allows; every
// outline run calls the model; classify and suggestions run at their gates.
const HOUR = 3_600_000;
const t0 = Date.parse("2026-10-08T08:00:00Z");

/** Call times for one document edited from `start` for `ms`. */
function editingCalls(start: number, ms: number): number[] {
  const times: number[] = [];
  for (let t = start + nextRefreshDelay(start, null); t < start + ms; t += nextRefreshDelay(t, t)) times.push(t);
  for (let t = start + CLASSIFY_MIN_INTERVAL_MS; t < start + ms; t += CLASSIFY_MIN_INTERVAL_MS) times.push(t);
  for (let t = start + MIN_GENERATE_INTERVAL_MS; t < start + ms; t += MIN_GENERATE_INTERVAL_MS) times.push(t);
  return times;
}

async function refusals(subject: { userId: string; teamId: string }, times: number[]) {
  let refused = 0;
  for (const now of [...times].sort((a, b) => a - b)) if (!(await reserveModelCall(subject, "light", { now })).ok) refused++;
  return refused;
}

describe("light defaults against the background cadences", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    delete process.env.SASHA_LIMIT_LIGHT_USER;
    delete process.env.SASHA_LIMIT_LIGHT_TEAM;
    resetLimiter();
  });

  it("an 8-hour writing day never hits the user windows", async () => {
    const times = editingCalls(t0, 8 * HOUR);
    expect(times.length).toBeGreaterThan(900);
    expect(await refusals({ userId: "u1", teamId: "org:a" }, times)).toBe(0);
  });

  it("two documents edited at once for an hour stay under the 10-minute window", async () => {
    expect(await refusals({ userId: "u1", teamId: "org:a" }, [...editingCalls(t0, HOUR), ...editingCalls(t0 + 7_000, HOUR)])).toBe(0);
  });

  it("five people writing all day stay under the team window", async () => {
    let refused = 0;
    for (let u = 0; u < 5; u++) refused += await refusals({ userId: `u${u}`, teamId: "org:a" }, editingCalls(t0, 8 * HOUR));
    expect(refused).toBe(0);
  });
});
