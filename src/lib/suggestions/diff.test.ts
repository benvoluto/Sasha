import { describe, expect, it } from "vitest";
import { fileTypeByKey } from "@/catalog/files";
import type { SuggestionRecord } from "./contract";
import { inputsHash, MAX_NOTES_PROPOSALS, MAX_TYPE_ITEMS, mergeProposals, neededItem, subtractCovered, subtractDismissed, typeNeeds } from "./diff";

const row = (kind: SuggestionRecord["kind"], label: string, state: SuggestionRecord["state"]) => ({ kind, label, state });

describe("typeNeeds", () => {
  it("unions sourcesNeeded and dataNeeded of the proposal type in section order", () => {
    const def = fileTypeByKey("proposal")!;
    const items = typeNeeds(def);
    expect(items.map((i) => [i.kind, i.label, i.spec_ref])).toEqual([
      ["data", "Total cost", "summary"],
      ["data", "Duration", "summary"],
      ["source", "Evidence of the problem or opportunity", "reason"],
      ["data", "Baseline figures", "reason"],
      ["data", "Targets", "objectives"],
      ["data", "Milestone dates", "timeline"],
      ["source", "Quotes or cost estimates", "budget"],
      ["data", "Cost figures", "budget"],
    ]);
    expect(items[0].reason).toBe("The Summary section uses this.");
    expect(items[0].dedupe_key).toBe("data:total cost");
  });

  it("dedupes across sections, keeps the first spec_ref, names the others, and caps", () => {
    const section = (key: string, order: number, sources: string[], data: string[]) => ({ key, heading: key.toUpperCase(), order, sourcesNeeded: sources, dataNeeded: data });
    const items = typeNeeds({
      sections: [section("b", 20, ["Annual report."], ["Revenue"]), section("a", 10, ["annual  REPORT"], []), section("c", 30, [], ["revenue"])] as never,
    });
    expect(items.map((i) => [i.label, i.spec_ref])).toEqual([
      ["annual  REPORT".replace(/\s+/g, " "), "a"],
      ["Revenue", "b"],
    ]);
    expect(items[0].reason).toBe("The A section uses this. Also used in: B.");
    expect(items[1].reason).toBe("The B section uses this. Also used in: C.");

    const many = Array.from({ length: 60 }, (_, i) => `Item ${i}`);
    expect(typeNeeds({ sections: [section("x", 1, many, [])] as never })).toHaveLength(MAX_TYPE_ITEMS);
  });

  it("treats a source and a data item with the same label as different items", () => {
    const items = typeNeeds({ sections: [{ key: "s", heading: "S", order: 1, sourcesNeeded: ["Budget"], dataNeeded: ["Budget"] }] as never });
    expect(items.map((i) => i.kind)).toEqual(["source", "data"]);
  });
});

describe("subtracting and merging", () => {
  const items = [neededItem("source", "Annual report", "", null), neededItem("data", "Revenue", "", null), neededItem("web", "Census tables", "", null)];

  it("drops dismissed items only (web folds into source)", () => {
    const left = subtractDismissed(items, [row("data", "revenue.", "dismissed"), row("source", "Annual report", "added"), row("source", "census tables", "dismissed")]);
    expect(left.map((i) => i.label)).toEqual(["Annual report"]);
  });

  it("drops covered items", () => {
    expect(subtractCovered(items, new Map([["data:revenue", "s1"]])).map((i) => i.label)).toEqual(["Annual report", "Census tables"]);
  });

  it("merges proposals: duplicates of type items and of each other are dropped, capped", () => {
    const proposals = [
      { kind: "data" as const, label: "REVENUE" },
      { kind: "source" as const, label: "Audited accounts" },
      { kind: "source" as const, label: "audited accounts." },
      { kind: "data" as const, label: "  " },
      ...Array.from({ length: 12 }, (_, i) => ({ kind: "data" as const, label: `Figure ${i}` })),
    ];
    const merged = mergeProposals(items, proposals);
    expect(merged[0].label).toBe("Audited accounts");
    expect(merged).toHaveLength(MAX_NOTES_PROPOSALS);
    expect(merged.some((m) => m.label === "REVENUE")).toBe(false);
  });
});

describe("inputsHash", () => {
  const a = { id: "a", title: "A", summary: "x" };
  const b = { id: "b", title: "B", summary: null };
  it("is stable and independent of source order", () => {
    const h = inputsHash({ typeKey: "proposal", typeVersion: 1, notes: "n", sources: [a, b] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(inputsHash({ typeKey: "proposal", typeVersion: 1, notes: "n", sources: [b, a] })).toBe(h);
  });
  it("changes with the type, its version, the notes or a source summary", () => {
    const h = inputsHash({ typeKey: "proposal", typeVersion: 1, notes: "n", sources: [a] });
    expect(inputsHash({ typeKey: "memo", typeVersion: 1, notes: "n", sources: [a] })).not.toBe(h);
    expect(inputsHash({ typeKey: "proposal", typeVersion: 2, notes: "n", sources: [a] })).not.toBe(h);
    expect(inputsHash({ typeKey: "proposal", typeVersion: 1, notes: "m", sources: [a] })).not.toBe(h);
    expect(inputsHash({ typeKey: "proposal", typeVersion: 1, notes: "n", sources: [{ ...a, summary: "y" }] })).not.toBe(h);
    expect(inputsHash({ typeKey: "proposal", typeVersion: 1, notes: "n", sources: [] })).not.toBe(h);
  });
});
