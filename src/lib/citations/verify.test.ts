import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { buildGrounding } from "@/lib/sections/grounding";
import { passagePrefix } from "@/lib/sources/pages";
import { createSource, linkSource, replacePassages, resetSourceStore } from "@/lib/sources/store";
import type { PassageResolver, ResolvedPassage } from "./contract";
import { boundedLevenshtein, groundingResolver, guardText, quoteMatches, verifyMarkers, wordingChanged } from "./verify";

const A = "S1a2b3c4d.P1";
const B = "S1a2b3c4d.P2";
const OTHER = "Sdeadbeef.P1";

const passage = (passageId: string, text: string, linked = true): ResolvedPassage => ({ passageId, sourceId: `src-${passageId.slice(1, 9)}`, sourceTitle: "Q3 Report", page: 4, text, linked });

function resolver(map: Record<string, ResolvedPassage>): PassageResolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (id: string) => {
    calls.push(id);
    return map[id] ?? null;
  }) as PassageResolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const base = resolver({
  [A]: passage(A, "Demand rose 12 percent year over year, the “fastest” growth since 2019."),
  [B]: passage(B, "Prices held steady through the third quarter."),
  [OTHER]: passage(OTHER, "Unlinked text.", false),
});

describe("verifyMarkers", () => {
  it("keeps valid markers, normalized to the bare form, and fills the report", async () => {
    const { markdown, report } = await verifyMarkers(`Demand rose 12%.[[p:${A}|Demand rose 12 percent]] Prices held.[[p: ${B} ]]`, base);
    expect(markdown).toBe(`Demand rose 12%.[[p:${A}]] Prices held.[[p:${B}]]`);
    expect(report.kept).toBe(2);
    expect(report.dropped).toEqual([]);
    expect(report.passages[A]).toEqual({ passageId: A, sourceId: "src-1a2b3c4d", sourceTitle: "Q3 Report", page: 4, quote: "Demand rose 12 percent", excerpt: expect.stringContaining("Demand rose") });
    expect(report.passages[B].quote).toBeNull();
  });

  it("drops each kind of bad marker with one preceding space", async () => {
    const md = `One [[p:not-an-id]]. Two [[p:S00000000.P1]]. Three [[p:${OTHER}]]. Four [[p:${B}|prices fell sharply]].`;
    const { markdown, report } = await verifyMarkers(md, base);
    expect(markdown).toBe("One. Two. Three. Four.");
    expect(report.kept).toBe(0);
    expect(report.dropped.map((d) => [d.passageId, d.reason])).toEqual([
      ["not-an-id", "malformed"],
      ["S00000000.P1", "unknown_passage"],
      [OTHER, "not_linked"],
      [B, "quote_mismatch"],
    ]);
  });

  it("matches quotes tolerantly: curly quotes, case, punctuation and a trailing ellipsis", async () => {
    const quotes = ['the "FASTEST" growth', "demand rose 12 percent year-over-year…", "Demand  rose,12 percent...", "x"];
    for (const q of quotes) {
      const { report } = await verifyMarkers(`Fact.[[p:${A}|${q}]]`, base);
      expect(report.kept, q).toBe(1);
    }
    // Too short to check: kept, but not recorded as the quote.
    expect((await verifyMarkers(`Fact.[[p:${A}|x]]`, base)).report.passages[A].quote).toBeNull();
    expect(quoteMatches("growth since 2020", "the fastest growth since 2019")).toBe(false);
  });

  it("matches quotes by whole words, so a misquoted figure or a partial word fails", async () => {
    expect(quoteMatches("Demand rose 1%", "Demand rose 12% in 2024.")).toBe(false);
    expect(quoteMatches("ales fell", "Sales fell sharply.")).toBe(false);
    expect(quoteMatches("Demand rose 12%", "Demand rose 12% in 2024.")).toBe(true);
    // A partial last word only after an ellipsis.
    expect(quoteMatches("Demand rose 12% in 20", "Demand rose 12% in 2024.")).toBe(false);
    expect(quoteMatches("Demand rose 12% in 20…", "Demand rose 12% in 2024.")).toBe(true);
    const r = resolver({ [A]: passage(A, "Demand rose 12% in 2024.") });
    const { markdown, report } = await verifyMarkers(`Demand rose 1%.[[p:${A}|Demand rose 1%]]`, r);
    expect(markdown).toBe("Demand rose 1%.");
    expect(report.dropped.map((d) => d.reason)).toEqual(["quote_mismatch"]);
  });

  it("reads quotes holding single brackets or longer than the cap, and never passes an unread marker through", async () => {
    const id = "S1a2b3c4d.P1";
    const long = `${"word ".repeat(150)}end`;
    const r = resolver({ [id]: passage(id, `Growth was 12% [3] in 2025. ${long}`) });
    const bracket = await verifyMarkers(`Growth hit 12%.[[p:${id}|Growth was 12% [3] in 2025]]`, r);
    expect(bracket.markdown).toBe(`Growth hit 12%.[[p:${id}]]`);
    expect(bracket.report.kept).toBe(1);
    expect(bracket.report.passages[id].quote).toBe("Growth was 12% [3] in 2025");

    const longQuote = await verifyMarkers(`Words.[[p:${id}|${long}]]`, r);
    expect(longQuote.markdown).toBe(`Words.[[p:${id}]]`);
    expect(longQuote.report.kept).toBe(1);
    expect(longQuote.report.passages[id].quote?.endsWith("…")).toBe(true);

    for (const md of [`Bad.[[p:${id}|has [[3]] inside]] Next.`, `Open.[[p:${id}|never closed\nNext line.`, `Ok.[[p:${id}]] Bad [[p:${id}|x [[y]] z]].`]) {
      const { markdown, report } = await verifyMarkers(md, r);
      expect(markdown, md).not.toContain("[[p:" + id + "|");
      expect(report.dropped.some((d) => d.reason === "malformed"), md).toBe(true);
    }
  });

  it("lets the first quote that matched win", async () => {
    const { report } = await verifyMarkers(`A.[[p:${A}]] B.[[p:${A}|year over year]] C.[[p:${A}|fastest growth]]`, base);
    expect(report.passages[A].quote).toBe("year over year");
    expect(report.kept).toBe(3);
  });

  it("drops markers in table rows and heading lines as malformed", async () => {
    const md = [`### Growth [[p:${A}]]`, "", "| Year | Demand |", "|---|---|", `| 2025 | +12% [[p:${A}]] |`, "", `Demand rose.[[p:${A}]]`].join("\n");
    const { markdown, report } = await verifyMarkers(md, base);
    expect(markdown).toBe(["### Growth", "", "| Year | Demand |", "|---|---|", "| 2025 | +12% |", "", `Demand rose.[[p:${A}]]`].join("\n"));
    expect(report.dropped.map((d) => d.reason)).toEqual(["malformed", "malformed"]);
    expect(report.kept).toBe(1);
  });

  it("strips stray bracketed passage ids without a record", async () => {
    const { markdown, report } = await verifyMarkers(`Demand rose [S1a2b3c4d.P7]. Prices [[S1a2b3c4d.P8]] held.`, base);
    expect(markdown).toBe("Demand rose. Prices held.");
    expect(report.dropped).toEqual([]);
  });

  it("collapses runs of the same marker and asks the resolver once per id", async () => {
    const r = resolver({ [A]: passage(A, "Demand rose.") });
    const { markdown, report } = await verifyMarkers(`Demand rose.[[p:${A}]] [[p:${A}]][[p:${A}]] Again.[[p:${A}]]`, r);
    expect(markdown).toBe(`Demand rose.[[p:${A}]] Again.[[p:${A}]]`);
    expect(report.kept).toBe(2);
    expect(r.calls).toEqual([A]);
  });

  it("returns the text untouched when there are no markers", async () => {
    expect(await verifyMarkers("Plain text.", base)).toEqual({ markdown: "Plain text.", report: { kept: 0, dropped: [], passages: {} } });
  });
});

describe("groundingResolver", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
  });

  async function seed(team: string, docId: string, text: string, link = true) {
    const s = await createSource(team, "ann", { kind: "note", title: `${team} notes`, extracted_text: text, extraction_status: "ready" });
    const id = `${passagePrefix(s.id)}.P0`;
    await replacePassages(team, s.id, [{ id, idx: 0, page: null, start_offset: 0, end_offset: text.length, text }]);
    if (link) await linkSource(team, "ann", docId, s.id);
    return { source: s, id };
  }

  it("resolves the shown passages, other passages of linked sources, and unlinked team sources as not linked", async () => {
    const d = await createDocument("org:a", "ann");
    const linked = await seed("org:a", d.id, "Linked fact.");
    const extra = `${passagePrefix(linked.source.id)}.P5`;
    await replacePassages("org:a", linked.source.id, [
      { id: linked.id, idx: 0, page: 1, start_offset: 0, end_offset: 12, text: "Linked fact." },
      { id: extra, idx: 5, page: 2, start_offset: 13, end_offset: 30, text: "A passage not shown." },
    ]);
    const unlinked = await seed("org:a", d.id, "Unlinked fact.", false);
    const g = await buildGrounding("org:a", d.id, { budget: 40 });
    const resolve = groundingResolver("org:a", d.id, g);
    expect(await resolve(linked.id)).toMatchObject({ sourceId: linked.source.id, linked: true, sourceTitle: "org:a notes" });
    expect(await resolve(extra)).toMatchObject({ text: "A passage not shown.", page: 2, linked: true });
    expect(await resolve(unlinked.id)).toMatchObject({ sourceId: unlinked.source.id, linked: false });
    expect(await resolve(`${passagePrefix(linked.source.id)}.P99`)).toBeNull();
  });

  it("never sees another team's passage", async () => {
    const mine = await createDocument("org:a", "ann");
    const theirs = await createDocument("org:b", "bob");
    const b = await seed("org:b", theirs.id, "Team B secret.");
    const resolve = groundingResolver("org:a", mine.id, { sources: [], passages: [] });
    expect(await resolve(b.id)).toBeNull();
    const { report } = await verifyMarkers(`Fact.[[p:${b.id}]]`, resolve);
    expect(report.dropped).toEqual([{ raw: `[[p:${b.id}]]`, passageId: b.id, reason: "unknown_passage" }]);
    // Team B's own resolver sees it.
    expect(await groundingResolver("org:b", theirs.id, { sources: [], passages: [] })(b.id)).toMatchObject({ linked: true });
  });

  it("caches lookups per resolver", async () => {
    const d = await createDocument("org:a", "ann");
    const { id } = await seed("org:a", d.id, "Fact.");
    const store = await import("@/lib/sources/store");
    const spy = vi.spyOn(store, "listPassages");
    const resolve = groundingResolver("org:a", d.id, { sources: [], passages: [] });
    await resolve(id);
    await resolve(id);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("Cite sources wording guard", () => {
  const body = "Demand rose 12 percent in 2025. Prices held steady through the third quarter, and the council approved the plan.";

  it("accepts a reply that only adds markers (and light Markdown)", () => {
    expect(wordingChanged(body, `Demand rose 12 percent in 2025.[[p:${A}]] Prices held steady through the third quarter, and the council approved the plan.[[p:${B}|held steady]]`)).toBe(false);
    expect(wordingChanged("Item one\n\nItem two", "- Item one\n- Item two")).toBe(false);
    expect(guardText(`**Demand** rose [S1a2b3c4d.P1].[[p:${A}]]`)).toBe("Demand rose.");
  });

  it("refuses a reply that changes more than 2% of the characters", () => {
    expect(wordingChanged(body, "Demand grew 12 percent during 2025. Prices stayed flat in Q3, and the council said yes.")).toBe(true);
    // One small fix in a long text is within 2%.
    expect(wordingChanged(body, body.replace("council", "Council"))).toBe(false);
    expect(wordingChanged(body, `${body} An added sentence that was never there.`)).toBe(true);
  });

  it("computes a bounded edit distance quickly on long, nearly equal texts", () => {
    expect(boundedLevenshtein("kitten", "sitting", 5)).toBe(3);
    expect(boundedLevenshtein("kitten", "sitting", 2)).toBe(3);
    expect(boundedLevenshtein("", "abc", 5)).toBe(3);
    const long = "word ".repeat(4000);
    const t0 = Date.now();
    expect(boundedLevenshtein(long, `${long.slice(0, 9000)}X${long.slice(9001)}`, 400)).toBe(1);
    expect(boundedLevenshtein(long, long.split("").reverse().join("") + "zz", 400)).toBe(401);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
