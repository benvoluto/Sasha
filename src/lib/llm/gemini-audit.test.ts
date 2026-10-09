import { beforeEach, describe, expect, it, vi } from "vitest";

const { write } = vi.hoisted(() => ({ write: vi.fn<(e: unknown) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/ontology/governance", () => ({ defaultAuditSink: () => ({ write }) }));

import { withModelContext } from "./context";
import { auditedGenerate, auditGemini, geminiUsage, stubGeminiUsage } from "./gemini-audit";

describe("geminiUsage", () => {
  it("maps usageMetadata to the audit keys, thinking counted as output and cached tokens out of input", () => {
    // promptTokenCount (100) already includes the 40 cached tokens.
    expect(geminiUsage("gemini-3.6-flash", { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 40 })).toEqual({
      model: "gemini-3.6-flash",
      input_tokens: 60,
      output_tokens: 25,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    });
    expect(geminiUsage("m", null)).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    expect(geminiUsage("m", { promptTokenCount: 80 })).toMatchObject({ input_tokens: 80, cache_read_input_tokens: 0 });
    // Never negative, even if a reply reports more cached tokens than prompt tokens.
    expect(geminiUsage("m", { promptTokenCount: 10, cachedContentTokenCount: 30 })).toMatchObject({ input_tokens: 0, cache_read_input_tokens: 30 });
  });
});

describe("auditedGenerate", () => {
  beforeEach(() => write.mockClear());

  it("writes one row per call with the kind, model, usage and the model context", async () => {
    const res = await withModelContext({ teamId: "org:a", userId: "u1", agent: "ann", documentId: "d1" }, () =>
      auditedGenerate("extract", "gemini-3.6-flash", async () => ({ text: "x", usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } })),
    );
    expect(res.text).toBe("x");
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "ann",
        action: "llm:gemini.extract",
        task: "gemini.extract",
        model: "gemini-3.6-flash",
        teamId: "org:a",
        userId: "u1",
        documentId: "d1",
        allowed: true,
        latencyMs: expect.any(Number),
        result: expect.objectContaining({ input_tokens: 7, output_tokens: 3 }),
      }),
    );
  });

  it("audits a failed call as not allowed and rethrows", async () => {
    await expect(auditedGenerate("tables", "gemini-3.6-flash", async () => Promise.reject(new Error("429 quota")))).rejects.toThrow("429 quota");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ action: "llm:gemini.tables", allowed: false, agent: "system", teamId: null, result: { model: "gemini-3.6-flash", error: "429 quota" } }));
  });

  it("never throws when the audit write fails", async () => {
    write.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(auditGemini({ kind: "extract", model: "m", usage: null, latencyMs: 1 })).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("gives stub replies token counts", () => {
    expect(stubGeminiUsage("abcd", "abcdefgh")).toEqual({ promptTokenCount: 1, candidatesTokenCount: 2 });
  });
});
