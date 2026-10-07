import { describe, expect, it } from "vitest";
import { FIE_TEMPLATE, GENERAL_REPORT_TEMPLATE, isRewritable, REPORT_TEMPLATES, templateByKey } from "./template";

describe("report templates", () => {
  it("selects by key and falls back to the general report", () => {
    expect(templateByKey("fie_basic")).toBe(FIE_TEMPLATE);
    expect(templateByKey("general_report")).toBe(GENERAL_REPORT_TEMPLATE);
    expect(templateByKey("nope")).toBe(GENERAL_REPORT_TEMPLATE);
    expect(templateByKey(null)).toBe(GENERAL_REPORT_TEMPLATE);
  });

  it("gives every template a preamble and only rewritable narrative sections", () => {
    for (const t of REPORT_TEMPLATES) {
      expect(t.preamble.length).toBeGreaterThan(20);
      expect(new Set(t.sections.map((s) => s.key)).size).toBe(t.sections.length);
      expect(t.sections.every((s) => s.kind === "narrative" && isRewritable(s))).toBe(true);
    }
  });
});
