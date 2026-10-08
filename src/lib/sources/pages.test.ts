import { describe, expect, it } from "vitest";
import { checkCitations } from "./passages";
import { MAX_PASSAGE_TEXT_CHARS, pagedPassages, passagePrefix } from "./pages";
import type { StoredPassage } from "./store";

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** A passage's raw stretch, whitespace collapsed: what its text must equal. */
const text = (raw: string, p: StoredPassage) => raw.slice(p.start_offset, p.end_offset).replace(/\s+/g, " ");

describe("pagedPassages", () => {
  it("gives stable ids from the source id", () => {
    expect(passagePrefix(ID)).toBe("S1a2b3c4d");
    const text = "First sentence here. Second sentence here.";
    const a = pagedPassages(ID, text);
    const b = pagedPassages(ID, text);
    expect(a).toEqual(b);
    expect(a.map((p) => p.id)).toEqual(["S1a2b3c4d.P0"]);
    expect(a[0]).toMatchObject({ idx: 0, page: null });
  });

  it("takes page numbers from page markers", () => {
    const text = "--- Page 1 ---\nIntro text on page one.\n\n--- Page 2 ---\nThe budget is $40,000.\n--- Page 3 ---\n";
    const ps = pagedPassages(ID, text);
    expect(ps.map((p) => [p.page, p.text])).toEqual([
      [1, "Intro text on page one."],
      [2, "The budget is $40,000."],
    ]);
    expect(ps.map((p) => p.idx)).toEqual([0, 1]);
  });

  it("resets the page at each document marker", () => {
    const text = [
      "=== Document: a.pdf ===",
      "--- Page 4 ---",
      "Alpha content.",
      "=== Document: b.docx ===",
      "Beta content without pages.",
      "--- Page 1 ---",
      "Gamma content.",
    ].join("\n");
    expect(pagedPassages(ID, text).map((p) => [p.page, p.text])).toEqual([
      [4, "Alpha content."],
      [null, "Beta content without pages."],
      [1, "Gamma content."],
    ]);
  });

  it("maps offsets back to the original text", () => {
    const text = "--- Page 7 ---\n  The  first\nsentence wraps.   Then another one follows.\n";
    const [p] = pagedPassages(ID, text);
    expect(p.text).toBe("The first sentence wraps. Then another one follows.");
    const raw = text.slice(p.start_offset, p.end_offset);
    expect(raw.startsWith("The  first")).toBe(true);
    expect(raw.endsWith("follows.")).toBe(true);
    expect(raw.replace(/\s+/g, " ")).toBe(p.text);
  });

  it("splits long pages into several passages with increasing offsets", () => {
    const sentence = (i: number) => `Sentence number ${i} says something reasonably long about the topic at hand.`;
    const text = "--- Page 1 ---\n" + Array.from({ length: 40 }, (_, i) => sentence(i)).join(" ");
    const ps = pagedPassages(ID, text);
    expect(ps.length).toBeGreaterThan(2);
    for (let i = 1; i < ps.length; i++) expect(ps[i].start_offset).toBeGreaterThanOrEqual(ps[i - 1].end_offset);
    for (const p of ps) expect(text.slice(p.start_offset, p.end_offset)).toBe(p.text);
    expect(ps.every((p) => p.page === 1)).toBe(true);
  });

  it("produces passages citations can be checked against", () => {
    const ps = pagedPassages(ID, "--- Page 1 ---\nThe council approved the plan on May 3.");
    const asPassages = ps.map((p) => ({ passage_id: p.id, doc_id: ID, doc_type: "source", text: p.text }));
    expect(checkCitations([{ passage_id: "S1a2b3c4d.P0", quote: "approved the plan" }], asPassages).verified).toBe(1);
  });

  it("caps passage length for text with no sentence ends (CSV, lists, tables)", () => {
    const csv = ["id,name,amount", ...Array.from({ length: 2000 }, (_, i) => `${i},Item ${i},${i * 3}`)].join("\n");
    const ps = pagedPassages(ID, csv);
    expect(ps.length).toBeGreaterThan(50);
    for (const p of ps) {
      expect(p.text.length).toBeLessThanOrEqual(600);
      expect(text(csv, p)).toBe(p.text);
    }
    // Cut at line breaks: every passage holds whole rows.
    expect(ps.every((p) => /^\d+,Item \d+,\d+$|^id,/.test(csv.slice(p.start_offset, p.end_offset).split("\n")[0]))).toBe(true);
    expect(ps.every((p) => csv[p.end_offset] === undefined || csv[p.end_offset] === "\n")).toBe(true);

    const list = Array.from({ length: 200 }, (_, i) => `- point ${i} about the plan`).join("\n");
    const lp = pagedPassages(ID, list);
    expect(lp.length).toBeGreaterThan(5);
    expect(lp.every((p) => p.text.length <= 600 && p.text.startsWith("- point"))).toBe(true);
  });

  it("cuts an over-long run at spaces, and mid-word only when there are none", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const wp = pagedPassages(ID, words);
    expect(wp.length).toBeGreaterThan(1);
    expect(wp.every((p) => p.text.length <= 600 && /^word\d+( word\d+)*$/.test(p.text))).toBe(true);
    expect(wp.map((p) => p.text).join(" ")).toBe(words);

    const blob = "x".repeat(1500);
    const bp = pagedPassages(ID, blob);
    expect(bp.map((p) => p.text.length)).toEqual([600, 600, 300]);
    expect(bp.map((p) => [p.start_offset, p.end_offset])).toEqual([[0, 600], [600, 1200], [1200, 1500]]);
  });

  it("only splits the first MAX_PASSAGE_TEXT_CHARS of a huge text", () => {
    const big = "abc def. ".repeat(Math.ceil((MAX_PASSAGE_TEXT_CHARS + 50_000) / 9));
    const ps = pagedPassages(ID, big);
    expect(ps[ps.length - 1].end_offset).toBeLessThanOrEqual(MAX_PASSAGE_TEXT_CHARS);
    expect(ps.every((p) => p.text.length <= 600)).toBe(true);
  });

  it("returns nothing for empty or marker-only text", () => {
    expect(pagedPassages(ID, "")).toEqual([]);
    expect(pagedPassages(ID, "=== Document: a.pdf ===\n--- Page 1 ---\n   \n")).toEqual([]);
  });
});
