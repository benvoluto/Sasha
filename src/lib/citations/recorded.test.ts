// Contract test over a real section draft with citation markers, recorded from
// the live test (SASHA_LIVE_TESTS=1 SASHA_RECORD_FIXTURES=1 npx vitest run
// src/lib/citations/cite.live.test.ts). Pins the marker shapes the model
// actually writes (bare and quoted, after the sentence with or without a
// space, in list items) through verifyMarkers and markCitations, offline.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PMNode } from "@/lib/documents/sections";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import { passagePrefix } from "@/lib/sources/pages";
import { collectCitations, parseMarkers, type PassageResolver } from "./contract";
import { verifyMarkers } from "./verify";

type Recorded = {
  reply: string;
  grounding: { sources: Array<{ id: string; title: string }>; passages: Array<{ id: string; idx: number; page: number | null; text: string }> };
};

const recorded = JSON.parse(readFileSync(new URL("./__fixtures__/draft.citations.recorded.json", import.meta.url), "utf8")) as Recorded;

/** The resolver groundingResolver builds from the passages the model was shown. */
const resolve: PassageResolver = async (id) => {
  const p = recorded.grounding.passages.find((x) => x.id === id);
  const s = recorded.grounding.sources.find((x) => passagePrefix(x.id) === id.split(".")[0]);
  return p && s ? { passageId: id, sourceId: s.id, sourceTitle: s.title, page: p.page, text: p.text, linked: true } : null;
};

const textOf = (n: PMNode): string => (n.text ?? "") + (n.content ?? []).map(textOf).join("");

describe("draft.section recorded reply with citations", () => {
  it("keeps every marker the model wrote, quotes included", async () => {
    const markers = parseMarkers(recorded.reply);
    expect(markers.length).toBeGreaterThan(0);
    const { markdown, report } = await verifyMarkers(recorded.reply, resolve);
    expect(report.dropped).toEqual([]);
    expect(report.kept).toBe(markers.length);
    // Quotes moved into the report; the markdown only has bare markers.
    expect(parseMarkers(markdown).every((m) => m.quote === null)).toBe(true);
    for (const id of new Set(markers.map((m) => m.passageId))) expect(report.passages[id]).toBeDefined();
  });

  it("turns the markers into marks over real text, none in table cells or headings", async () => {
    const { markdown, report } = await verifyMarkers(recorded.reply, resolve);
    const blocks = sectionBlocksFromMarkdown(markdown, 2, { citations: report });
    const doc: PMNode = { type: "doc", content: blocks };
    expect(JSON.stringify(blocks)).not.toContain("[[p:");
    const { references } = collectCitations(doc);
    expect(references.map((r) => r.passageId).sort()).toEqual(Object.keys(report.passages).sort());

    // The cited text of each textblock (its cited text nodes, joined).
    const cited: string[] = [];
    const walk = (n: PMNode, inTableOrHeading: boolean) => {
      const flag = inTableOrHeading || n.type === "table" || n.type === "heading";
      const spans = (n.content ?? []).filter((c) => c.type === "text" && c.marks?.some((m) => m.type === "citation"));
      if (spans.length) {
        expect(flag).toBe(false);
        cited.push(spans.map((c) => c.text).join(""));
      }
      (n.content ?? []).forEach((c) => walk(c, flag));
    };
    walk(doc, false);
    expect(cited.length).toBeGreaterThan(0);
    // Cited text ends a sentence and never starts with whitespace.
    for (const t of cited) {
      expect(t).toMatch(/[.!?]$/);
      expect(t).not.toMatch(/^\s/);
    }
    // The visible text lost only the markers.
    expect(blocks.map(textOf).join(" ")).not.toMatch(/\[\[|\]\]/);
  });
});
