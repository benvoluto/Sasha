import { afterEach, describe, expect, it, vi } from "vitest";
import { testType } from "@/lib/sections/test-fixtures";
import { FIE_TEMPLATE, GENERAL_REPORT_TEMPLATE, isRewritable, REPORT_TEMPLATES, templateByKey, templateFromDefinition } from "./template";

describe("report templates", () => {
  it("selects by legacy or catalog key and falls back to the general report", () => {
    expect(templateByKey("fie_basic")).toBe(FIE_TEMPLATE);
    expect(templateByKey("general_report")).toBe(GENERAL_REPORT_TEMPLATE);
    expect(templateByKey("fie")).toBe(FIE_TEMPLATE);
    expect(templateByKey("general-report")).toBe(GENERAL_REPORT_TEMPLATE);
    expect(templateByKey("nope")).toBe(GENERAL_REPORT_TEMPLATE);
    expect(templateByKey(null)).toBe(GENERAL_REPORT_TEMPLATE);
  });

  it("keeps the legacy keys and gives every template a preamble and only rewritable narrative sections", () => {
    expect(GENERAL_REPORT_TEMPLATE.key).toBe("general_report");
    expect(FIE_TEMPLATE.key).toBe("fie_basic");
    for (const t of REPORT_TEMPLATES) {
      expect(t.preamble.length).toBeGreaterThan(20);
      expect(t.preamble).toContain("Ground every statement in the sources provided.");
      expect(new Set(t.sections.map((s) => s.key)).size).toBe(t.sections.length);
      expect(t.sections.every((s) => s.kind === "narrative" && isRewritable(s))).toBe(true);
    }
    // FIE keeps its section keys so stored report_section rows still match.
    expect(FIE_TEMPLATE.sections.map((s) => s.key)).toEqual(expect.arrayContaining(["student_background", "reason_for_referral", "recommendations"]));
  });

  it("derives a template from a catalog definition", () => {
    const t = templateFromDefinition(testType(), "legacy_key");
    expect(t).toMatchObject({ key: "legacy_key", title: "Test Proposal" });
    expect(t.preamble).toBe("You are a grant writer drafting a funding proposal. Ground every statement in the sources provided. Do NOT invent figures, dates, names, or facts; when the sources are silent, say so briefly rather than guessing.");
    expect(t.sections[0]).toEqual({ key: "memo-header", heading: "Header", order: 5, kind: "static", guidance: "**To:** \n**From:**" });
    expect(t.sections[1]).toMatchObject({ key: "summary", kind: "narrative", guidance: "Summarize the request in one paragraph." });
  });
});

describe("report templates without the catalog types", () => {
  afterEach(() => {
    vi.doUnmock("@/catalog/files");
    vi.resetModules();
  });

  it("falls back to the built-in definitions", async () => {
    vi.resetModules();
    vi.doMock("@/catalog/files", () => ({ fileTypeByKey: () => null }));
    const m = await import("./template");
    expect(m.GENERAL_REPORT_TEMPLATE).toBe(m.FALLBACK_GENERAL_REPORT_TEMPLATE);
    expect(m.FIE_TEMPLATE).toBe(m.FALLBACK_FIE_TEMPLATE);
    expect(m.templateByKey("fie")).toBe(m.FALLBACK_FIE_TEMPLATE);
    expect(m.FIE_TEMPLATE.preamble).toContain("Do not state a final determination");
  });

  it("uses the catalog definitions when present", async () => {
    vi.resetModules();
    const def = testType();
    vi.doMock("@/catalog/files", () => ({ fileTypeByKey: (k: string) => (k === "fie" ? def : null) }));
    const m = await import("./template");
    expect(m.FIE_TEMPLATE).toMatchObject({ key: "fie_basic", title: "Test Proposal" });
    expect(m.GENERAL_REPORT_TEMPLATE).toBe(m.FALLBACK_GENERAL_REPORT_TEMPLATE);
  });
});
