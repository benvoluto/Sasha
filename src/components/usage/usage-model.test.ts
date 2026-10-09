import { describe, expect, it } from "vitest";
import { dayLabel, formatCost, newestFirst, formatCount, metricValue, niceScale, presetOf, presetRange, costLabel, taskLabel, totalTokens, usageUrl } from "./usage-model";

const NOW = Date.parse("2026-10-08T23:30:00Z");
const totals = { calls: 3, errors: 0, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, web_search_requests: 0, cost_usd: 0.5, priced_cost_usd: 0.5 };

describe("usage model", () => {
  it("builds preset ranges in UTC, today included, and recognises them", () => {
    expect(presetRange(7, NOW)).toEqual({ from: "2026-10-02", to: "2026-10-08" });
    expect(presetRange(90, NOW)).toEqual({ from: "2026-07-11", to: "2026-10-08" });
    expect(presetOf({ from: "2026-10-02", to: "2026-10-08" }, NOW)).toBe(7);
    expect(presetOf({ from: "2026-10-01", to: "2026-10-08" }, NOW)).toBeNull();
  });

  it("builds the API and CSV URLs", () => {
    expect(usageUrl({ from: "2026-10-01", to: "2026-10-08" })).toBe("/api/usage?from=2026-10-01&to=2026-10-08");
    expect(usageUrl({ from: "2026-10-01", to: "2026-10-08" }, "csv")).toBe("/api/usage?from=2026-10-01&to=2026-10-08&format=csv");
  });

  it("formats counts and costs", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(12_900)).toBe("12.9K");
    expect(formatCount(4_200_000)).toBe("4.2M");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.0125)).toBe("$0.0125");
    expect(formatCost(0.0574)).toBe("$0.0574");
    expect(formatCost(0.5)).toBe("$0.50");
  });

  it("lists the day table newest first without touching the response", () => {
    const days = [{ day: "2026-10-07" }, { day: "2026-10-08" }, { day: "2026-10-09" }];
    expect(newestFirst(days).map((d) => d.day)).toEqual(["2026-10-09", "2026-10-08", "2026-10-07"]);
    expect(days[0].day).toBe("2026-10-07");
    expect(formatCost(1234.5)).toBe("$1,234.50");
  });

  it("sums tokens, priced cost and chart values", () => {
    expect(totalTokens(totals)).toBe(18);
    expect(metricValue(totals, "calls")).toBe(3);
    expect(metricValue(totals, "tokens")).toBe(18);
    expect(costLabel(totals)).toBe("$0.50");
    expect(costLabel({ cost_usd: null, priced_cost_usd: 40 })).toBe("At least $40.00");
    expect(costLabel({ cost_usd: null, priced_cost_usd: 0 })).toBe("—");
  });

  it("labels tasks and days", () => {
    expect(taskLabel("draft.section")).toBe("Draft section");
    expect(taskLabel("gemini.extract")).toBe("Gemini extract");
    expect(dayLabel("2026-10-07")).toBe("Oct 7");
    expect(dayLabel("2026-01-01", true)).toBe("Jan 1, 2026");
  });

  it("picks clean axis maxima and ticks", () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(93)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(1234).max).toBe(1500);
  });
});
