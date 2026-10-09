import { describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/documents/sections";
import { citationAttrs, citationHref, citationKey, collectCitations, MAX_MARKER_QUOTE, parseMarkers, PASSAGE_ID_RE } from "./contract";

const cite = (attrs: Record<string, unknown>) => ({ type: "citation", attrs });
const t = (text: string, marks?: PMNode["marks"]): PMNode => ({ type: "text", text, ...(marks ? { marks } : {}) });
const p = (...content: PMNode[]): PMNode => ({ type: "paragraph", content });

describe("parseMarkers", () => {
  it("finds bare and quoted markers with their offsets", () => {
    const text = "Costs rose.[[p:S1a2b3c4d.P7]] Prices held.[[p:S1a2b3c4d.P8| held steady ]]";
    expect(parseMarkers(text)).toEqual([
      { raw: "[[p:S1a2b3c4d.P7]]", passageId: "S1a2b3c4d.P7", quote: null, index: 11, length: 18 },
      { raw: "[[p:S1a2b3c4d.P8| held steady ]]", passageId: "S1a2b3c4d.P8", quote: "held steady", index: 42, length: 32 },
    ]);
  });

  it("finds malformed markers too, so they can be reported and removed", () => {
    const [m] = parseMarkers("Text [[p: not an id ]] more.");
    expect(m.passageId).toBe("not an id");
    expect(PASSAGE_ID_RE.test(m.passageId)).toBe(false);
    expect(PASSAGE_ID_RE.test("S1a2b3c4d.P7")).toBe(true);
    expect(PASSAGE_ID_RE.test("S1A2B3C4D.P7")).toBe(false);
  });

  it("reads adjacent markers separately and treats an empty quote as none", () => {
    const ms = parseMarkers("A.[[p:S1a2b3c4d.P1]][[p:S1a2b3c4d.P2|]]");
    expect(ms.map((m) => [m.passageId, m.quote])).toEqual([
      ["S1a2b3c4d.P1", null],
      ["S1a2b3c4d.P2", null],
    ]);
  });

  it("cuts a long quote and can be called repeatedly (no lastIndex state)", () => {
    const long = "w ".repeat(250);
    const text = `X.[[p:S1a2b3c4d.P1|${long}]]`;
    expect(parseMarkers(text)[0].quote!.length).toBeLessThanOrEqual(MAX_MARKER_QUOTE);
    expect(parseMarkers(text)).toHaveLength(1);
  });
});

describe("citationAttrs", () => {
  it("reads loose stored attrs with fallbacks", () => {
    expect(citationAttrs(undefined)).toEqual({ kind: "passage", passageId: null, sourceId: null, dataTableId: null, quote: null, verified: false });
    expect(citationAttrs({ kind: "table", dataTableId: "t1", sourceId: "s1", verified: "true", quote: "  " })).toEqual({
      kind: "table",
      passageId: null,
      sourceId: "s1",
      dataTableId: "t1",
      quote: null,
      verified: true,
    });
    expect(citationAttrs({ kind: "weird", passageId: 7, verified: "yes" })).toMatchObject({ kind: "passage", passageId: null, verified: false });
  });

  it("keys passages and tables, and nothing without an id", () => {
    expect(citationKey({ kind: "passage", passageId: "S1a2b3c4d.P1", dataTableId: null })).toBe("p:S1a2b3c4d.P1");
    expect(citationKey({ kind: "table", passageId: null, dataTableId: "t1" })).toBe("t:t1");
    expect(citationKey({ kind: "table", passageId: null, dataTableId: null })).toBeNull();
    expect(citationKey({ kind: "passage", passageId: null, dataTableId: null })).toBeNull();
  });
});

describe("collectCitations", () => {
  it("numbers references by first appearance, depth first, and counts each once", () => {
    const a = cite({ kind: "passage", passageId: "S1a2b3c4d.P2", sourceId: "s1", quote: "first" });
    const b = cite({ kind: "passage", passageId: "S1a2b3c4d.P1", sourceId: "s1" });
    const tbl = cite({ kind: "table", dataTableId: "t1", sourceId: "s2" });
    const doc: PMNode = {
      type: "doc",
      content: [
        p(t("One.", [a]), t(" Two.", [a, b])),
        { type: "bulletList", content: [{ type: "listItem", content: [p(t("Table", [tbl]))] }] },
        p(t("Again.", [b]), t("Bad.", [cite({ kind: "passage" })])),
      ],
    };
    const { references, numberOf } = collectCitations(doc);
    expect(references.map((r) => [r.key, r.number, r.quote])).toEqual([
      ["p:S1a2b3c4d.P2", 1, "first"],
      ["p:S1a2b3c4d.P1", 2, null],
      ["t:t1", 3, null],
    ]);
    expect(numberOf.get("t:t1")).toBe(3);
    expect(collectCitations(null).references).toEqual([]);
  });
});

describe("citationHref", () => {
  it("opens the library drawer on the passage or table", () => {
    expect(citationHref({ kind: "passage", passageId: "S1a2b3c4d.P7", sourceId: "abc", dataTableId: null })).toBe("/library?source=abc&passage=S1a2b3c4d.P7");
    expect(citationHref({ kind: "table", passageId: null, sourceId: "abc", dataTableId: "t 1" })).toBe("/library?source=abc&table=t%201");
    expect(citationHref({ kind: "passage", passageId: null, sourceId: "abc", dataTableId: null })).toBe("/library?source=abc");
    expect(citationHref({ kind: "passage", passageId: "S1a2b3c4d.P7", sourceId: null, dataTableId: null })).toBeNull();
  });
});
