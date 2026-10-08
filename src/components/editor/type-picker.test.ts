import { describe, expect, it } from "vitest";
import type { DocumentTypeSummary } from "@/catalog/schema";
import { findType, groupByFamily, popularTypes } from "./type-picker";
import { rewriteItems } from "./section-menu";
import { nextRefreshDelay } from "./use-outline-status";

const t = (key: string, family: DocumentTypeSummary["family"], title = key, aliases: string[] = []): DocumentTypeSummary => ({
  key,
  version: 1,
  title,
  family,
  summary: "",
  aliases,
  origin: "file",
  enabled: true,
  overridden: false,
  sections: [],
});

describe("type picker helpers", () => {
  const types = [t("fie", "clinical", "FIE"), t("proposal", "business", "Proposal"), t("business-plan", "business", "Business plan"), t("general-report", "general", "General report"), t("policy-decision-memo", "policy", "Decision memo")];

  it("groups by family in catalog order, sorted by title", () => {
    expect(groupByFamily(types).map((g) => [g.family, g.types.map((x) => x.key)])).toEqual([
      ["business", ["business-plan", "proposal"]],
      ["policy", ["policy-decision-memo"]],
      ["clinical", ["fie"]],
      ["general", ["general-report"]],
    ]);
  });

  it("finds a type by key or legacy key", () => {
    expect(findType(types, "proposal")?.key).toBe("proposal");
    expect(findType(types, "general_report")?.key).toBe("general-report");
    expect(findType(types, "memo")?.key).toBe("policy-decision-memo");
    expect(findType(types, "nope")).toBeNull();
    expect(findType([t("team-brief", "general", "Brief", ["brief"])], "brief")?.key).toBe("team-brief");
    expect(findType(types, null)).toBeNull();
  });

  it("puts popular types first", () => {
    expect(popularTypes(types, 3).map((x) => x.key)).toEqual(["general-report", "proposal", "policy-decision-memo"]);
  });
});

describe("section menu rewrite items", () => {
  it("offers each preset, plus its opposite where one exists", () => {
    const items = rewriteItems();
    expect(items[0]).toEqual({ key: "concise", label: "More concise", direction: "more" });
    expect(items.filter((i) => i.direction === "less").map((i) => i.key)).toEqual(["concise", "plain_language", "strengths", "summarize"]);
    expect(items.find((i) => i.key === "expand")?.direction).toBe("more");
  });
});

describe("outline status refresh timing", () => {
  it("waits 4 s after a save, and at least 30 s between runs", () => {
    expect(nextRefreshDelay(100_000, null)).toBe(4000);
    expect(nextRefreshDelay(100_000, 50_000)).toBe(4000);
    expect(nextRefreshDelay(100_000, 90_000)).toBe(20_000);
  });
});
