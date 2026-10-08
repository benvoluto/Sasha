import { beforeEach, describe, expect, it } from "vitest";
import { createTeamType, getType, listTypes, listTypeSummaries, removeTypeEdits, saveOutlineAsType, saveTypeDefinition, setTypeEnabled } from "./index";
import { fileTypeByKey } from "./files";
import { DocumentTypeDefinition } from "./schema";
import { getTypeRow, insertTypeRow, resetCatalogStore, upsertTypeDefinition, upsertTypeEnabled } from "./store";
import { minimalType } from "./test-fixtures";

const T = "org:a";
const def = (over: Parameters<typeof minimalType>[0] = {}) => DocumentTypeDefinition.parse(minimalType(over));
const proposal = () => fileTypeByKey("proposal")!;

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetCatalogStore();
});

describe("merge rules", () => {
  it("file types with no rows are enabled, from the file, not overridden", async () => {
    const e = await getType(T, "proposal");
    expect(e).toMatchObject({ origin: "file", enabled: true, overridden: false, updated_at: null });
    expect(e?.definition).toEqual(proposal());
  });

  it("an override row replaces the definition (key forced) and carries enabled", async () => {
    await upsertTypeDefinition(T, "ann", "override", { ...proposal(), title: "Our proposal" });
    await upsertTypeEnabled(T, "ann", "proposal", "override", false);
    const e = await getType(T, "proposal");
    expect(e).toMatchObject({ origin: "file", overridden: true, enabled: false });
    expect(e?.definition.title).toBe("Our proposal");
    expect(await getType("org:b", "proposal")).toMatchObject({ overridden: false, enabled: true });
  });

  it("an enable-only row keeps the file definition", async () => {
    await upsertTypeEnabled(T, "ann", "proposal", "override", false);
    const e = await getType(T, "proposal");
    expect(e).toMatchObject({ overridden: false, enabled: false });
    expect(e?.definition).toEqual(proposal());
  });

  it("team rows are team types; disabled types are listed only with includeDisabled but returned by getType", async () => {
    await insertTypeRow(T, "ann", "team", def());
    expect((await listTypes(T)).find((e) => e.definition.key === "team-brief")).toMatchObject({ origin: "team", enabled: true });
    await setTypeEnabled(T, "ann", "team-brief", false);
    expect((await listTypes(T)).some((e) => e.definition.key === "team-brief")).toBe(false);
    expect((await listTypes(T, { includeDisabled: true })).some((e) => e.definition.key === "team-brief")).toBe(true);
    expect(await getType(T, "team-brief")).toMatchObject({ enabled: false });
  });

  it("lists by family then title", async () => {
    const families = (await listTypeSummaries(T)).map((s) => s.family);
    const order = ["grant", "business", "academic", "technical", "policy", "clinical", "career", "legal", "general", "other"];
    expect(families.map((f) => order.indexOf(f))).toEqual([...families.map((f) => order.indexOf(f))].sort((a, b) => a - b));
  });
});

describe("alias resolution", () => {
  it("resolves definition aliases and legacy aliases, for file and team types", async () => {
    expect((await getType(T, "general_report"))?.definition.key).toBe("general-report");
    await insertTypeRow(T, "ann", "team", def({ aliases: ["brief"] }));
    expect((await getType(T, "brief"))?.definition.key).toBe("team-brief");
    expect(await getType(T, "nope")).toBeNull();
    expect(await getType(T, null)).toBeNull();
  });
});

describe("admin writes", () => {
  it("createTeamType refuses file keys, file aliases and existing team keys", async () => {
    expect(await createTeamType(T, "ann", def({ key: "proposal" }))).toMatchObject({ ok: false, reason: "clash" });
    expect(await createTeamType(T, "ann", def({ key: "x-1", aliases: ["general_report"] }))).toMatchObject({ ok: false, reason: "clash" });
    expect(await createTeamType(T, "ann", def())).toMatchObject({ ok: true, entry: { origin: "team" } });
    expect(await createTeamType(T, "ann", def())).toMatchObject({ ok: false, reason: "clash" });
    expect(await createTeamType("org:b", "bob", def())).toMatchObject({ ok: true });
  });

  it("saveTypeDefinition bumps the version past the file and previous versions", async () => {
    const v = proposal().version;
    const first = await saveTypeDefinition(T, "ann", "proposal", { ...proposal(), title: "Ours", version: 99 });
    expect(first).toMatchObject({ ok: true, entry: { overridden: true, definition: { version: v + 1, title: "Ours" } } });
    const second = await saveTypeDefinition(T, "ann", "proposal", { ...proposal(), version: 1 });
    expect(second.ok && second.entry.definition.version).toBe(v + 2);
    expect(await saveTypeDefinition(T, "ann", "proposal", def({ key: "other" }))).toMatchObject({ ok: false, reason: "key_mismatch" });
    expect(await saveTypeDefinition(T, "ann", "missing", def({ key: "missing" }))).toMatchObject({ ok: false, reason: "not_found" });
    await createTeamType(T, "ann", def());
    const team = await saveTypeDefinition(T, "ann", "team-brief", def({ title: "Brief 2" }));
    expect(team).toMatchObject({ ok: true, entry: { origin: "team", definition: { version: 2, title: "Brief 2" } } });
  });

  it("removeTypeEdits reverts overrides (keeping a disabled flag) and deletes team types", async () => {
    expect(await removeTypeEdits(T, "ann", "proposal")).toBeNull();
    await saveTypeDefinition(T, "ann", "proposal", { ...proposal(), title: "Ours" });
    expect(await removeTypeEdits(T, "ann", "proposal")).toBe("reverted");
    expect(await getTypeRow(T, "proposal")).toBeNull();

    await saveTypeDefinition(T, "ann", "proposal", { ...proposal(), title: "Ours" });
    await setTypeEnabled(T, "ann", "proposal", false);
    expect(await removeTypeEdits(T, "ann", "proposal")).toBe("reverted");
    expect(await getType(T, "proposal")).toMatchObject({ overridden: false, enabled: false, definition: { title: proposal().title } });
    expect(await removeTypeEdits(T, "ann", "proposal")).toBeNull();

    await createTeamType(T, "ann", def());
    expect(await removeTypeEdits(T, "ann", "team-brief")).toBe("deleted");
    expect(await getType(T, "team-brief")).toBeNull();
  });

  it("saveOutlineAsType derives a unique key and uses the document's type", async () => {
    const content_json = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2, sectionId: "s_a", specKey: "summary" }, content: [{ type: "text", text: "Summary" }] },
        { type: "paragraph", content: [{ type: "text", text: "x" }] },
        { type: "heading", attrs: { level: 2, sectionId: "s_b", specKey: null }, content: [{ type: "text", text: "Extra Bit" }] },
      ],
    };
    const document = { title: "Doc", type_key: "proposal", content_json };
    const a = await saveOutlineAsType(T, "ann", { document, title: "Proposal" });
    expect(a).toMatchObject({ ok: true, specKeys: { s_a: "summary", s_b: "extra-bit" }, entry: { origin: "team", definition: { key: "proposal-2", family: "business" } } });
    if (a.ok) expect(a.entry.definition.sections[0].elements).toEqual(proposal().sections[0].elements);
    const b = await saveOutlineAsType(T, "ann", { document, title: "Proposal" });
    expect(b.ok && b.entry.definition.key).toBe("proposal-3");
    expect(await saveOutlineAsType(T, "ann", { document: { ...document, content_json: { type: "doc", content: [{ type: "paragraph" }] } }, title: "X" })).toMatchObject({ ok: false, reason: "no_headings" });
  });
});
