import { describe, expect, it, vi } from "vitest";
import type { DocumentTypeSummary } from "@/catalog/schema";
import { findType, groupByFamily, returnFocusTo } from "./type-picker";
import { article, suggestionAnnouncement } from "./classifier-chip";
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
});

describe("classifier suggestion", () => {
  const suggestion = (title: string) => ({ key: "k", title, confidence: 0.8, why: "", alternatives: [] });
  it("picks a or an", () => {
    expect(article("Proposal")).toBe("a");
    expect(article(" Incident report")).toBe("an");
  });
  it("announces a new suggestion and points to the Document Gallery", () => {
    expect(suggestionAnnouncement(suggestion("Grant proposal"))).toBe("Sasha suggests a Grant proposal outline. Open the Document Gallery to apply it.");
    expect(suggestionAnnouncement(suggestion("Executive summary"))).toMatch(/^Sasha suggests an Executive summary outline\./);
    expect(suggestionAnnouncement(null)).toBe("");
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

describe("returnFocusTo", () => {
  const event = () => ({ preventDefault: vi.fn() }) as unknown as Event & { preventDefault: ReturnType<typeof vi.fn> };
  it("focuses the element on the page instead of Radix's default", () => {
    const el = { isConnected: true, focus: vi.fn() } as unknown as HTMLElement;
    const e = event();
    returnFocusTo({ current: el })(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(el.focus).toHaveBeenCalled();
  });
  it("leaves Radix's default for a missing or removed element", () => {
    const gone = { isConnected: false, focus: vi.fn() } as unknown as HTMLElement;
    for (const ref of [undefined, { current: null }, { current: gone }]) {
      const e = event();
      returnFocusTo(ref)(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(gone.focus).not.toHaveBeenCalled();
  });
  it("focuses the control that opened the dialog when it is still on the page", () => {
    const el = { isConnected: true, focus: vi.fn() } as unknown as HTMLElement;
    const outlineButton = { isConnected: true, nodeName: "BUTTON", focus: vi.fn() } as unknown as HTMLElement;
    const e = event();
    returnFocusTo({ current: el }, () => outlineButton)(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(outlineButton.focus).toHaveBeenCalled();
    expect(el.focus).not.toHaveBeenCalled();
  });
  it("takes over when the opener was removed (a menu item) or was the page itself", () => {
    for (const from of [{ isConnected: false, nodeName: "DIV" }, { isConnected: true, nodeName: "BODY" }, null]) {
      const el = { isConnected: true, focus: vi.fn() } as unknown as HTMLElement;
      const e = event();
      returnFocusTo({ current: el }, () => from as unknown as Element | null)(e);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(el.focus).toHaveBeenCalled();
    }
  });
});
