import { describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/documents/sections";
import { markdownToTiptap } from "@/lib/report/markdown-to-tiptap";
import type { CitationReport } from "./contract";
import { markCitations } from "./marks";

const A = "S1a2b3c4d.P1";
const B = "S1a2b3c4d.P2";

const info = (passageId: string, quote: string | null = null) => ({ passageId, sourceId: "src-1", sourceTitle: "Q3 Report", page: 4, quote, excerpt: "…" });
const report: CitationReport = { kept: 2, dropped: [], passages: { [A]: info(A, "rose 12 percent"), [B]: info(B) } };

const blocks = (md: string) => markCitations(markdownToTiptap(md).content as PMNode[], report);

/** Each text node as [text, citation passage ids, other mark types]. */
const runs = (n: PMNode): Array<[string, string[], string[]]> =>
  (n.content ?? []).flatMap((c) =>
    c.type === "text"
      ? [[c.text ?? "", (c.marks ?? []).filter((m) => m.type === "citation").map((m) => String(m.attrs?.passageId)), (c.marks ?? []).filter((m) => m.type !== "citation").map((m) => m.type)] as [string, string[], string[]]]
      : c.content
        ? runs(c)
        : [],
  );

describe("markCitations", () => {
  it("turns a marker into a mark over the sentence before it and removes the marker", () => {
    const [p] = blocks(`Intro sentence. Demand rose 12%.[[p:${A}]] Prices held.`);
    expect(runs(p)).toEqual([
      ["Intro sentence. ", [], []],
      ["Demand rose 12%.", [A], []],
      [" Prices held.", [], []],
    ]);
    const mark = p.content!.find((c) => c.marks?.length)!.marks![0];
    expect(mark).toEqual({ type: "citation", attrs: { kind: "passage", passageId: A, sourceId: "src-1", dataTableId: null, quote: "rose 12 percent", verified: true } });
  });

  it("gives two markers after one sentence two marks on the same span", () => {
    const [p] = blocks(`Demand rose.[[p:${A}]][[p:${B}]] Next.`);
    expect(runs(p)).toEqual([
      ["Demand rose.", [A, B], []],
      [" Next.", [], []],
    ]);
  });

  it("starts a span after the previous marker group in the same sentence", () => {
    const [p] = blocks(`Demand rose [[p:${A}]] and prices held.[[p:${B}]]`);
    expect(runs(p)).toEqual([
      ["Demand rose", [A], []],
      [" ", [], []],
      ["and prices held.", [B], []],
    ]);
  });

  it("keeps bold on text a marker follows", () => {
    const [p] = blocks(`Plain start. **Demand rose sharply.**[[p:${A}]] End.`);
    expect(runs(p)).toEqual([
      ["Plain start. ", [], []],
      ["Demand rose sharply.", [A], ["bold"]],
      [" End.", [], []],
    ]);
  });

  it("drops a marker at the start of a paragraph without a mark", () => {
    const [p] = blocks(`[[p:${A}]] Demand rose.`);
    expect(runs(p)).toEqual([["Demand rose.", [], []]]);
    expect(JSON.stringify(p)).not.toContain("[[p:");
  });

  it("removes an id the report doesn't list without a mark", () => {
    const [p] = blocks("Demand rose.[[p:S99999999.P1]] Next.");
    expect(runs(p)).toEqual([["Demand rose. Next.", [], []]]);
  });

  it("reaches list items and leaves blocks without markers as they were", () => {
    const out = blocks(`No markers here.\n\n- First item.[[p:${A}]]\n- Second item.`);
    expect(out[0]).toEqual(markdownToTiptap("No markers here.").content[0]);
    expect(runs(out[1])).toEqual([
      ["First item.", [A], []],
      ["Second item.", [], []],
    ]);
  });
});
