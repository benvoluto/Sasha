import { describe, expect, it } from "vitest";
import type { SectionInfo } from "@/lib/documents/sections";
import { outlineHeadings, outlineTypeDefinition, slugify, typeKeyFromTitle, uniqueKey } from "./from-outline";
import { DocumentTypeDefinition, parseDefinition } from "./schema";
import { minimalType } from "./test-fixtures";

const sec = (heading: string, level: number, specKey: string | null = null, sectionId = `s_${slugify(heading) || "x"}`): SectionInfo => ({ sectionId, heading, level, specKey, index: 0, bodyText: "" });

describe("key helpers", () => {
  it("slugify / typeKeyFromTitle / uniqueKey", () => {
    expect(slugify("  Café Plans & Goals! ")).toBe("cafe-plans-goals");
    expect(typeKeyFromTitle("!!")).toBe("team-type");
    expect(typeKeyFromTitle("Grant Pitch")).toBe("grant-pitch");
    expect(uniqueKey("a", new Set(["a", "a-2"]))).toBe("a-3");
    expect(uniqueKey("b", new Set(["a"]))).toBe("b");
  });

  it("uses the headings at the smallest level in use", () => {
    expect(outlineHeadings([sec("T", 3), sec("A", 2), sec("B", 3), sec("C", 2), sec("  ", 1)]).map((s) => s.heading)).toEqual(["A", "C"]);
    expect(outlineHeadings([])).toEqual([]);
  });
});

describe("outlineTypeDefinition", () => {
  const source = DocumentTypeDefinition.parse(
    minimalType({ key: "src", preamble: "Source preamble.", audience: "Src audience.", tone: "Src tone.", family: "grant", sections: [{ key: "ask", heading: "Ask", order: 1, guidance: "g", elements: ["E1"], sourcesNeeded: ["S1"], dataNeeded: ["D1"] }] }),
  );

  it("keeps valid unique specKeys, slugs the rest, and copies matched sections' elements", () => {
    const built = outlineTypeDefinition({
      key: "pitch",
      title: "Pitch",
      documentTitle: "My doc",
      sections: [sec("The Ask", 2, "ask", "s_1"), sec("Notes", 2, "Not Valid", "s_2"), sec("Notes", 2, null, "s_3"), sec("Again", 2, "ask", "s_4"), sec("Sub", 3, "sub")],
      source,
      today: "2026-10-07",
    });
    expect(built).not.toBeNull();
    if (!built) return;
    expect(built.specKeys).toEqual({ s_1: "ask", s_2: "notes", s_3: "notes-2", s_4: "again" });
    const r = parseDefinition(built.definition);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    const d = r.definition;
    expect(d.sections.map((s) => [s.key, s.order, s.level])).toEqual([
      ["ask", 10, 2],
      ["notes", 20, 2],
      ["notes-2", 30, 2],
      ["again", 40, 2],
    ]);
    expect(d.sections[0]).toMatchObject({ elements: ["E1"], sourcesNeeded: ["S1"], dataNeeded: ["D1"], guidance: 'Write the "The Ask" section of this document.' });
    expect(d.sections[3].elements).toEqual(["E1"]);
    expect(d.sections[1].elements).toEqual([]);
    expect(d).toMatchObject({ preamble: "Source preamble.", audience: "Src audience.", tone: "Src tone.", family: "grant", provenance: { source: "Saved from a document outline", license: "Team", retrieved: "2026-10-07", url: "" } });
  });

  it("falls back to generic voice without a source type, and returns null without headings", () => {
    const built = outlineTypeDefinition({ key: "k-1", title: "T", family: "policy", summary: "Mine.", documentTitle: "", sections: [sec("Only", 1)], source: null, today: "2026-10-07" });
    expect(built?.definition).toMatchObject({ family: "policy", summary: "Mine.", audience: "General professional readers.", tone: "Plain, neutral, professional." });
    expect(built?.definition.preamble).toMatch(/^You are an experienced writer/);
    expect(outlineTypeDefinition({ key: "k-1", title: "T", documentTitle: "", sections: [], source: null, today: "2026-10-07" })).toBeNull();
  });
});
