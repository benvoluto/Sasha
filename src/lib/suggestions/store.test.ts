import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { applyGenerated, createUserSuggestion, getRun, getSuggestion, listSuggestions, planApply, safeUrl, setRun, setSuggestionState } from "./store";

const A = "org:a";
const B = "org:b";
const SRC = "11111111-1111-4111-8111-111111111111";
const item = (kind: "source" | "data" | "web", label: string, extra: Record<string, unknown> = {}) => ({ kind, label, reason: `why ${label}`, spec_ref: null, ...extra });

describe("suggestion store", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("inserts generated items open, or added with the covering source", async () => {
    const d = await createDocument(A, "ann");
    const list = (await applyGenerated(A, "ann", d.id, "type", [item("source", "Annual report", { spec_ref: "budget" }), item("data", "Revenue", { covered_by: SRC })]))!;
    expect(list.map((r) => [r.label, r.state, r.source_id, r.origin, r.spec_ref])).toEqual([
      ["Annual report", "open", null, "type", "budget"],
      ["Revenue", "added", SRC, "type", null],
    ]);
  });

  it("refreshes open rows, deletes stale open rows of the same origin, and never touches added/dismissed/user rows", async () => {
    const d = await createDocument(A, "ann");
    await applyGenerated(A, "ann", d.id, "type", [item("source", "Keep"), item("source", "Stale"), item("source", "Added"), item("source", "Dismissed"), item("data", "Covered later")]);
    await applyGenerated(A, "ann", d.id, "notes", [item("source", "From notes")]);
    const rows = (await listSuggestions(A, d.id))!;
    const id = (label: string) => rows.find((r) => r.label === label)!.id;
    await setSuggestionState(A, d.id, id("Added"), "add", SRC);
    await setSuggestionState(A, d.id, id("Dismissed"), "dismiss");
    const own = (await createUserSuggestion(A, "ann", d.id, { kind: "source", label: "My own" }))!;
    expect(own.created).toBe(true);

    const after = (await applyGenerated(A, "ann", d.id, "type", [
      item("source", "keep.", { reason: "fresh reason", spec_ref: "s1" }),
      item("source", "Added", { reason: "new" }),
      item("source", "Dismissed", { covered_by: SRC }),
      item("data", "Covered later", { covered_by: SRC }),
      item("source", "My own", { covered_by: SRC }),
    ]))!;
    const get = (label: string) => after.find((r) => r.label === label);
    expect(get("Keep")).toMatchObject({ state: "open", reason: "fresh reason", spec_ref: "s1" });
    expect(get("Stale")).toBeUndefined();
    expect(get("Added")).toMatchObject({ state: "added", source_id: SRC, reason: "why Added" });
    expect(get("Dismissed")).toMatchObject({ state: "dismissed", source_id: null });
    expect(get("Covered later")).toMatchObject({ state: "added", source_id: SRC });
    // The person's own row survives and only gains the covering source.
    expect(get("My own")).toMatchObject({ origin: "user", state: "added", source_id: SRC });
    // Another origin's open rows are left alone.
    expect(get("From notes")).toMatchObject({ origin: "notes", state: "open" });

    const cleared = (await applyGenerated(A, "ann", d.id, "type", []))!;
    expect(cleared.map((r) => r.label).sort()).toEqual(["Added", "Covered later", "Dismissed", "From notes", "My own"]);
  });

  it("dedupes across web and source, and a type item takes over an open notes row", async () => {
    const d = await createDocument(A, "ann");
    await applyGenerated(A, "ann", d.id, "notes", [item("web", "Census tables")]);
    const list = (await applyGenerated(A, "ann", d.id, "type", [item("source", "census tables", { spec_ref: "data" })]))!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "web", origin: "type", spec_ref: "data" });
    // The notes pass no longer proposes it, but it now belongs to the type origin.
    expect(await applyGenerated(A, "ann", d.id, "notes", [])).toHaveLength(1);
  });

  it("plans without duplicates and keeps only http(s) urls", () => {
    const plan = planApply([], "coverage", [item("web", "A", { url: "javascript:alert(1)" }), item("web", "a", { url: "https://x.org/a" }), item("web", "B", { url: "https://x.org/b" })]);
    expect(plan.insert.map((i) => [i.label, i.url])).toEqual([
      ["A", null],
      ["B", "https://x.org/b"],
    ]);
    expect(safeUrl("ftp://x")).toBeNull();
  });

  it("creates the person's own items, returning a duplicate restored to open", async () => {
    const d = await createDocument(A, "ann");
    const first = (await createUserSuggestion(A, "ann", d.id, { kind: "data", label: "Revenue", reason: "Needed" }))!;
    expect(first).toMatchObject({ created: true, suggestion: { origin: "user", state: "open", reason: "Needed" } });
    await setSuggestionState(A, d.id, first.suggestion.id, "dismiss");
    const again = (await createUserSuggestion(A, "ann", d.id, { kind: "data", label: "revenue." }))!;
    expect(again.created).toBe(false);
    expect(again.suggestion).toMatchObject({ id: first.suggestion.id, state: "open" });
  });

  it("adds, dismisses and restores; data items never keep a source", async () => {
    const d = await createDocument(A, "ann");
    const [s, data] = (await applyGenerated(A, "ann", d.id, "type", [item("source", "Report"), item("data", "Figures")]))!;
    expect(await setSuggestionState(A, d.id, s.id, "add", SRC)).toMatchObject({ state: "added", source_id: SRC });
    expect(await setSuggestionState(A, d.id, s.id, "restore")).toMatchObject({ state: "open", source_id: null });
    expect(await setSuggestionState(A, d.id, data.id, "add", SRC)).toMatchObject({ state: "added", source_id: null });
    expect(await setSuggestionState(A, d.id, data.id, "dismiss")).toMatchObject({ state: "dismissed" });
  });

  it("records runs", async () => {
    const d = await createDocument(A, "ann");
    expect(await getRun(A, d.id)).toBeNull();
    await setRun(A, d.id, { inputs_hash: "h", generated_at: "2026-01-01T00:00:00.000Z", error: null });
    expect(await getRun(A, d.id)).toMatchObject({ inputs_hash: "h", error: null });
    await setRun(A, d.id, { inputs_hash: "h2", generated_at: "2026-01-01T00:01:00.000Z", error: "boom" });
    expect(await getRun(A, d.id)).toMatchObject({ inputs_hash: "h2", error: "boom" });
  });

  it("scopes everything to the team", async () => {
    const d = await createDocument(A, "ann");
    const [s] = (await applyGenerated(A, "ann", d.id, "type", [item("source", "Report")]))!;
    expect(await listSuggestions(B, d.id)).toBeNull();
    expect(await getSuggestion(B, d.id, s.id)).toBeNull();
    expect(await setSuggestionState(B, d.id, s.id, "dismiss")).toBeNull();
    expect(await applyGenerated(B, "bob", d.id, "type", [])).toBeNull();
    expect(await createUserSuggestion(B, "bob", d.id, { kind: "source", label: "x" })).toBeNull();
    expect(await setRun(B, d.id, { inputs_hash: "h", generated_at: new Date().toISOString(), error: null })).toBeNull();
    expect(await getRun(B, d.id)).toBeNull();
    expect(await listSuggestions(A, "not-a-uuid")).toBeNull();
    // A suggestion of another document is not found through this one.
    const other = await createDocument(A, "ann");
    expect(await getSuggestion(A, other.id, s.id)).toBeNull();
    expect((await listSuggestions(A, d.id))![0].state).toBe("open");
  });

  it("is cleared by resetMemoryStore", async () => {
    const d = await createDocument(A, "ann");
    await applyGenerated(A, "ann", d.id, "type", [item("source", "Report")]);
    resetMemoryStore();
    const d2 = await createDocument(A, "ann");
    expect(await listSuggestions(A, d2.id)).toEqual([]);
  });
});
