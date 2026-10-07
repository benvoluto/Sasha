import { describe, expect, it } from "vitest";
import { modelForTier, resolveTask, supportsServerFallback } from "./tasks";

describe("task routing", () => {
  it("maps tasks to tiers with env overrides", () => {
    expect(resolveTask("classify.type", {}).model).toBe("claude-haiku-5-5");
    expect(resolveTask("rubric.check", {}).model).toBe("claude-sonnet-5-5");
    expect(resolveTask("draft.section", {}).model).toBe("claude-opus-5-5");
    expect(modelForTier("draft", { SASHA_MODEL_DRAFT: "claude-fable-5-1" })).toBe("claude-fable-5-1");
  });

  it("only opts Opus/Sonnet/Fable into the server-side fallback", () => {
    expect(supportsServerFallback("claude-opus-5-5")).toBe(true);
    expect(supportsServerFallback("claude-sonnet-5-5")).toBe(true);
    expect(supportsServerFallback("claude-haiku-5-5")).toBe(false);
  });
});
