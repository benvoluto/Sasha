import { describe, expect, it } from "vitest";
import { modelForTier, resolveTask, supportsServerFallback } from "./tasks";

describe("task routing", () => {
  it("maps tasks to tiers with env overrides", () => {
    expect(resolveTask("classify.type", {}).model).toBe("claude-haiku-5-5");
    expect(resolveTask("rubric.check", {}).model).toBe("claude-sonnet-5-5");
    expect(resolveTask("draft.section", {}).model).toBe("claude-opus-5-5");
    expect(resolveTask("rewrite.section", {})).toMatchObject({ tier: "draft", model: "claude-opus-5-5", maxTokens: 16000 });
    expect(modelForTier("draft", { SASHA_MODEL_DRAFT: "claude-fable-5-1" })).toBe("claude-fable-5-1");
  });

  it("routes the Phase 6 workflow tasks", () => {
    expect(resolveTask("workflow.gate", {})).toMatchObject({ tier: "fast", model: "claude-haiku-5-5" });
    for (const t of ["web.find", "workflow.extract", "workflow.trace", "workflow.review", "workflow.check", "workflow.decide"] as const) expect(resolveTask(t, {}).model).toBe("claude-sonnet-5-5");
    expect(resolveTask("workflow.review", {}).effort).toBe("high");
    expect(resolveTask("draft.traced", {})).toMatchObject({ tier: "draft", model: "claude-opus-5-5" });
    // Short enough that claude.ts sends them as plain requests (web search loops on pause_turn).
    expect(resolveTask("web.find", {}).maxTokens).toBeLessThanOrEqual(16000);
  });

  it("only opts Opus/Sonnet/Fable into the server-side fallback", () => {
    expect(supportsServerFallback("claude-opus-5-5")).toBe(true);
    expect(supportsServerFallback("claude-sonnet-5-5")).toBe(true);
    expect(supportsServerFallback("claude-haiku-5-5")).toBe(false);
  });
});
