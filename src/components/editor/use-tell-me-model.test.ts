import { describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import { history, undo, undoDepth } from "@tiptap/pm/history";
import { Node as PMNodeClass } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { outlineDoc } from "@/catalog/outline";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import { tellMeInstruction } from "@/lib/tell-me/contract";
import { documentExtensions } from "./extensions";
import { sectionBodyRange } from "./tracked-range";
import { draftSection, finalPhase, replaceDocTr, runDraftPool, tellMeTargets, tellMeUndoNote, type DraftOutcome, type TellMeTarget } from "./use-tell-me-model";

const schema = getSchema(documentExtensions());
const sections = [
  { key: "front", heading: "Front matter", order: 0, level: 2 as const, renderer: "static" as const, scaffold: "Name:\nDate:" },
  { key: "summary", heading: "Summary", order: 1, level: 2 as const, renderer: "narrative" as const },
  { key: "findings", heading: "Findings", order: 2, level: 2 as const, renderer: "narrative" as const },
];
let n = 0;
const ids = () => `s_${++n}`;

describe("tellMeTargets", () => {
  it("lists the laid-out headings of draftable sections, in document order", () => {
    n = 0;
    const doc = PMNodeClass.fromJSON(schema, outlineDoc(sections, ids));
    expect(tellMeTargets(doc, sections)).toEqual([
      { sectionId: "s_2", heading: "Summary", level: 2, specKey: "summary" },
      { sectionId: "s_3", heading: "Findings", level: 2, specKey: "findings" },
    ]);
  });

  it("skips headings without an id or outline item", () => {
    const doc = PMNodeClass.fromJSON(schema, {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2, sectionId: "s_a", specKey: null }, content: [{ type: "text", text: "Mine" }] },
        { type: "heading", attrs: { level: 2, sectionId: null, specKey: "summary" }, content: [{ type: "text", text: "Summary" }] },
        { type: "paragraph" },
      ],
    });
    expect(tellMeTargets(doc, sections)).toEqual([]);
  });
});

const target = (i: number): TellMeTarget => ({ sectionId: `s_${i}`, heading: `Section ${i}`, level: 2, specKey: `k${i}` });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("draftSection", () => {
  it("posts a draft with the prompt as the instruction", async () => {
    const fetchFn = vi.fn(async () => json(200, { markdown: "Text.", lineBreaks: false, citations: null }));
    const out = await draftSection(fetchFn as unknown as typeof fetch, "doc1", { ...target(1), sectionId: "s/1" }, "A report");
    expect(out).toEqual({ kind: "ok", markdown: "Text.", lineBreaks: false, citations: null });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/documents/doc1/sections/s%2F1/generate");
    expect(JSON.parse(String(init.body))).toEqual({ mode: "draft", heading: "Section 1", level: 2, specKey: "k1", body: "", instruction: tellMeInstruction("A report") });
  });

  it("tells a rate limit from other failures", async () => {
    const limited = await draftSection((async () => json(429, { error: "You've used your 30 drafts." })) as unknown as typeof fetch, "d", target(1), "p");
    expect(limited).toEqual({ kind: "limited", error: "You've used your 30 drafts." });
    const failed = await draftSection((async () => json(500, {})) as unknown as typeof fetch, "d", target(1), "p");
    expect(failed).toEqual({ kind: "failed", error: "“Section 1”: Claude couldn't write this section (500)." });
    const offline = await draftSection((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch, "d", target(2), "p");
    expect(offline).toEqual({ kind: "failed", error: "“Section 2”: Couldn't reach the server." });
  });
});

/** A fake draft whose calls resolve when the test says so. */
function controlledDraft() {
  const pending = new Map<string, (o: DraftOutcome) => void>();
  const started: string[] = [];
  const draft = (t: TellMeTarget) =>
    new Promise<DraftOutcome>((resolve) => {
      started.push(t.sectionId);
      pending.set(t.sectionId, resolve);
    });
  const settle = async (id: string, o: DraftOutcome) => {
    pending.get(id)!(o);
    pending.delete(id);
    // Let the worker go round its loop.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { draft, started, settle };
}

const ok: DraftOutcome = { kind: "ok", markdown: "x", lineBreaks: false, citations: null };

describe("runDraftPool", () => {
  it("runs `concurrency` at a time and starts the next as each finishes", async () => {
    const c = controlledDraft();
    const results: string[] = [];
    const done = runDraftPool({ items: [1, 2, 3, 4, 5].map(target), concurrency: 3, draft: c.draft, stopped: () => false, onResult: (t) => results.push(t.sectionId) });
    await Promise.resolve();
    expect(c.started).toEqual(["s_1", "s_2", "s_3"]);
    await c.settle("s_2", ok);
    expect(c.started).toEqual(["s_1", "s_2", "s_3", "s_4"]);
    for (const id of ["s_1", "s_3", "s_4"]) await c.settle(id, ok);
    await c.settle("s_5", ok);
    await done;
    expect(results).toEqual(["s_2", "s_1", "s_3", "s_4", "s_5"]);
  });

  it("stops starting sections after a 429 and keeps the running ones", async () => {
    const c = controlledDraft();
    const results: Array<[string, string]> = [];
    const done = runDraftPool({ items: [1, 2, 3, 4, 5].map(target), concurrency: 3, draft: c.draft, stopped: () => false, onResult: (t, o) => results.push([t.sectionId, o.kind]) });
    await Promise.resolve();
    await c.settle("s_1", ok);
    expect(c.started).toEqual(["s_1", "s_2", "s_3", "s_4"]);
    await c.settle("s_2", { kind: "limited", error: "Too many drafts." });
    await c.settle("s_3", ok);
    await c.settle("s_4", ok);
    await done;
    expect(c.started).toEqual(["s_1", "s_2", "s_3", "s_4"]);
    expect(results).toEqual([["s_1", "ok"], ["s_2", "limited"], ["s_3", "ok"], ["s_4", "ok"]]);
  });

  it("stops starting sections once stopped (Stop pressed)", async () => {
    const c = controlledDraft();
    let stop = false;
    const done = runDraftPool({ items: [1, 2, 3].map(target), concurrency: 1, draft: c.draft, stopped: () => stop, onResult: () => {} });
    await Promise.resolve();
    stop = true;
    await c.settle("s_1", ok);
    await done;
    expect(c.started).toEqual(["s_1"]);
  });

  it("goes on after an ordinary failure, and resolves at once with nothing to do", async () => {
    const outcomes: DraftOutcome[] = [{ kind: "failed", error: "a" }, ok];
    const seen: string[] = [];
    await runDraftPool({ items: [1, 2].map(target), concurrency: 3, draft: async () => outcomes.shift()!, stopped: () => false, onResult: (_t, o) => seen.push(o.kind) });
    expect(seen).toEqual(["failed", "ok"]);
    await expect(runDraftPool({ items: [], concurrency: 3, draft: async () => ok, stopped: () => false, onResult: () => {} })).resolves.toBeUndefined();
  });
});

describe("replaceDocTr: the whole run as one undo step", () => {
  it("lays out and drafts outside history, then swaps so one undo restores the document before", () => {
    let state = EditorState.create({ schema, plugins: [history()] });
    // Something typed earlier, then deleted: the document before is an empty paragraph.
    state = state.apply(state.tr.insertText("Hi", 1));
    state = state.apply(state.tr.delete(1, 3));
    const before = state.doc.toJSON();

    // The outline, then each section's draft, all outside the history.
    n = 0;
    state = state.apply(replaceDocTr(state, outlineDoc(sections, ids), false));
    for (const id of ["s_2", "s_3"]) {
      const r = sectionBodyRange(state.doc, id)!;
      const blocks = sectionBlocksFromMarkdown(`Drafted ${id}.`, r.level).map((b) => PMNodeClass.fromJSON(schema, b));
      state = state.apply(state.tr.replaceWith(r.from, r.to, blocks).setMeta("addToHistory", false));
    }
    const final = state.doc.toJSON();
    const depth = undoDepth(state);

    state = state.apply(replaceDocTr(state, before, false));
    state = state.apply(replaceDocTr(state, final, true));
    expect(state.doc.toJSON()).toEqual(final);
    expect(state.doc.textContent).toContain("Drafted s_3.");
    expect(undoDepth(state)).toBe(depth + 1);

    let undone = state;
    expect(undo(state, (tr) => (undone = state.apply(tr)))).toBe(true);
    expect(undone.doc.toJSON()).toEqual(before);
  });
});

describe("tellMeUndoNote and finalPhase", () => {
  it("says what Undo does only when something was drafted", () => {
    expect(tellMeUndoNote(3)).toBe("Undo removes the text; the type and notes stay.");
    expect(tellMeUndoNote(0)).toBeNull();
  });
  it("fails only when nothing was drafted and something went wrong", () => {
    expect(finalPhase(0, ["x"])).toBe("failed");
    expect(finalPhase(1, ["x"])).toBe("done");
    expect(finalPhase(0, [])).toBe("done");
  });
});
