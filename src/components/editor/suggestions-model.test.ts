import { describe, expect, it } from "vitest";
import type { SuggestionRecord } from "@/lib/suggestions/contract";
import { applyAction, dismissedItems, doneItems, doneText, groupOpen, loadAfterSave, NOTES_GROUP, OTHER_GROUP, showEmptyHint, upsertRow } from "./suggestions-model";

let n = 0;
const rec = (over: Partial<SuggestionRecord>): SuggestionRecord => {
  n += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return { id: `id${n}`, document_id: "d", kind: "source", label: `L${n}`, reason: "", spec_ref: null, url: null, origin: "type", state: "open", source_id: null, data_table_id: null, created_at: at, updated_at: at, ...over };
};
const sections = [
  { key: "summary", heading: "Summary" },
  { key: "budget", heading: "Budget" },
];

describe("suggestions-model", () => {
  it("groups open items by kind, then by section in type order, with notes and other groups last", () => {
    const rows = [
      rec({ kind: "data", label: "Costs", spec_ref: "budget" }),
      rec({ kind: "source", label: "Notes item", origin: "notes" }),
      rec({ kind: "source", label: "Quote", spec_ref: "budget" }),
      rec({ kind: "source", label: "Evidence", spec_ref: "summary" }),
      rec({ kind: "source", label: "Mine", origin: "user" }),
      rec({ kind: "source", label: "Unknown ref", spec_ref: "gone" }),
      rec({ kind: "web", label: "Census", origin: "coverage", url: "https://x.org" }),
      rec({ kind: "source", label: "Done", state: "added" }),
      rec({ kind: "data", label: "Hidden", state: "dismissed" }),
    ];
    const g = groupOpen(rows, sections);
    expect(g.map((k) => [k.title, k.count])).toEqual([
      ["Sources to find", 5],
      ["Data to gather", 1],
      ["On the web", 1],
    ]);
    expect(g[0].sections.map((s) => [s.heading, s.items.map((i) => i.label)])).toEqual([
      ["Summary", ["Evidence"]],
      ["Budget", ["Quote"]],
      [NOTES_GROUP, ["Notes item"]],
      [OTHER_GROUP, ["Mine", "Unknown ref"]],
    ]);
  });

  it("lists done and dismissed items, most recent first, and says what covers a done item", () => {
    const a = rec({ state: "added", source_id: "s1" });
    const b = rec({ state: "added", kind: "data" });
    const c = rec({ state: "dismissed" });
    expect(doneItems([a, b, c]).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(dismissedItems([a, b, c]).map((r) => r.id)).toEqual([c.id]);
    const titles = new Map([["s1", "Annual report"]]);
    expect(doneText(a, titles)).toBe("Covered by Annual report");
    expect(doneText({ kind: "source", source_id: "zz" }, titles)).toBe("Covered by a linked source");
    expect(doneText(b, titles)).toBe("Noted");
    expect(doneText({ kind: "source", source_id: null }, titles)).toBe("Added");
  });

  it("applies actions optimistically and upserts rows", () => {
    const r = rec({});
    expect(applyAction(r, "add", "s1")).toMatchObject({ state: "added", source_id: "s1" });
    expect(applyAction(rec({ kind: "data" }), "add", "s1")).toMatchObject({ state: "added", source_id: null });
    expect(applyAction({ ...r, source_id: "s1", state: "added" }, "restore")).toMatchObject({ state: "open", source_id: null });
    expect(applyAction(r, "dismiss")).toMatchObject({ state: "dismissed" });
    const list = [r];
    expect(upsertRow(list, { ...r, label: "x" })).toEqual([{ ...r, label: "x" }]);
    expect(upsertRow(list, rec({}))).toHaveLength(2);
  });

  it("covers a data item with a linked table", () => {
    const d = rec({ kind: "data", state: "added", data_table_id: "t1" });
    expect(doneText(d, new Map(), new Map([["t1", "Monthly sales"]]))).toBe("Covered by Monthly sales");
    expect(doneText(d, new Map())).toBe("Covered by a linked table");
    expect(doneText({ ...d, data_table_id: null }, new Map())).toBe("Noted");
    // A table id never names a source item.
    expect(doneText({ kind: "source", source_id: null, data_table_id: "t1" }, new Map(), new Map([["t1", "X"]]))).toBe("Added");
  });

  it("adds a data item with its table, keeps an earlier table, and clears it on dismiss and restore", () => {
    const d = rec({ kind: "data" });
    expect(applyAction(d, "add", "s1", "t1")).toMatchObject({ state: "added", source_id: null, data_table_id: "t1" });
    expect(applyAction({ ...d, data_table_id: "t0" }, "add")).toMatchObject({ state: "added", data_table_id: "t0" });
    expect(applyAction(d, "add")).toMatchObject({ state: "added", data_table_id: null });
    expect(applyAction({ ...d, state: "added", data_table_id: "t1" }, "restore")).toMatchObject({ state: "open", data_table_id: null, source_id: null });
    expect(applyAction({ ...d, data_table_id: "t1" }, "dismiss")).toMatchObject({ state: "dismissed", data_table_id: null });
    // A source item never takes a table.
    expect(applyAction(rec({}), "add", "s1", "t1")).toMatchObject({ source_id: "s1", data_table_id: null });
  });

  it("shows the empty hint only for an untyped document with nothing suggested", () => {
    expect(showEmptyHint([], null)).toBe(true);
    expect(showEmptyHint([], "proposal")).toBe(false);
    expect(showEmptyHint([rec({})], null)).toBe(false);
  });
});

describe("loadAfterSave", () => {
  it("waits for the queued save before loading, so the list is judged against the notes just typed", async () => {
    const order: string[] = [];
    let release!: () => void;
    const saved = new Promise<void>((r) => (release = r));
    const done = loadAfterSave(
      async () => {
        order.push("save:start");
        await saved;
        order.push("save:end");
        return "d1";
      },
      async () => {
        order.push("load");
        return "list";
      },
    );
    await Promise.resolve();
    expect(order).toEqual(["save:start"]);
    release();
    expect(await done).toBe("list");
    expect(order).toEqual(["save:start", "save:end", "load"]);
  });

  it("still loads when the save fails or there's nothing to save with", async () => {
    expect(await loadAfterSave(() => Promise.reject(new Error("offline")), async () => 1)).toBe(1);
    expect(await loadAfterSave(undefined, async () => 2)).toBe(2);
  });
});
