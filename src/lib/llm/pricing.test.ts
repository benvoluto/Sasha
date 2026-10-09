import { describe, expect, it } from "vitest";
import { costOf, priceFor, PRICING_AS_OF, PRICING_NOTE, WEB_SEARCH_USD_PER_REQUEST } from "./pricing";

describe("priceFor", () => {
  it("matches exact, dated and suffixed ids by the longest prefix", () => {
    expect(priceFor("claude-opus-5-5")?.model).toBe("claude-opus-5-5");
    expect(priceFor("claude-opus-5-5-20260901")?.model).toBe("claude-opus-5-5");
    expect(priceFor("claude-opus-5-5[1m]")?.model).toBe("claude-opus-5-5");
    expect(priceFor("claude-opus-5")?.model).toBe("claude-opus-5");
    expect(priceFor("claude-sonnet-5-20260101")?.model).toBe("claude-sonnet-5");
    expect(priceFor("anthropic.claude-haiku-5-5")?.model).toBe("claude-haiku-5-5");
  });

  it("returns null for unknown models, Gemini and lookalike ids", () => {
    expect(priceFor("gemini-3.6-flash")).toBeNull();
    expect(priceFor("claude-sonnet-55")).toBeNull();
    expect(priceFor("unknown")).toBeNull();
    expect(priceFor(null)).toBeNull();
  });
});

describe("costOf", () => {
  it("prices input, output, cache reads and writes per million tokens", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write.
    expect(costOf("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(29.2, 10);
    expect(costOf("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 500 })).toBeCloseTo(0.009, 10);
  });

  it("adds web searches", () => {
    expect(costOf("claude-sonnet-5-5", { web_search_requests: 3 })).toBeCloseTo(3 * WEB_SEARCH_USD_PER_REQUEST, 10);
  });

  it("uses Haiku 5.5's long-prompt rates above 100k prompt tokens", () => {
    expect(costOf("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0 })).toBeCloseTo(0.01, 10);
    expect(costOf("claude-haiku-5-5", { input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 1_000_000 })).toBeCloseTo(0.045 + 0.001 + 2.5, 10);
  });

  it("is null for a model with no price and ignores junk counts", () => {
    expect(costOf("gemini-3.6-flash", { input_tokens: 10 })).toBeNull();
    expect(costOf("claude-opus-5-5", { input_tokens: -5, output_tokens: Number.NaN })).toBe(0);
  });

  it("says the figures are estimates and dates them", () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICING_NOTE).toMatch(/^Estimates .*check current pricing\.$/);
  });
});
