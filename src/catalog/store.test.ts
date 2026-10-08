import { beforeEach, describe, expect, it } from "vitest";
import { DocumentTypeDefinition } from "./schema";
import { clearTypeDefinition, deleteTypeRow, getTypeRow, insertTypeRow, listTypeRows, resetCatalogStore, upsertTypeDefinition, upsertTypeEnabled } from "./store";
import { minimalType } from "./test-fixtures";

const T = "org:a";
const def = (over: Parameters<typeof minimalType>[0] = {}) => DocumentTypeDefinition.parse(minimalType(over));

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetCatalogStore();
});

describe("catalog store (memory)", () => {
  it("inserts, refuses a duplicate, upserts keeping enabled, toggles and deletes", async () => {
    expect(await insertTypeRow(T, "ann", "team", def())).not.toBeNull();
    expect(await insertTypeRow(T, "ann", "team", def())).toBeNull();
    await upsertTypeEnabled(T, "ann", "team-brief", "team", false);
    const updated = await upsertTypeDefinition(T, "bob", "team", def({ title: "Renamed", version: 2 }));
    expect(updated).toMatchObject({ title: "Renamed", version: 2, enabled: false, created_by: "ann", updated_by: "bob" });
    expect(await listTypeRows("org:b")).toEqual([]);
    expect(await deleteTypeRow(T, "team-brief")).toBe(true);
    expect(await getTypeRow(T, "team-brief")).toBeNull();
  });

  it("refuses to store an invalid definition", async () => {
    await expect(upsertTypeDefinition(T, "ann", "team", { ...def(), sections: [] } as never)).rejects.toThrow(/Invalid document type/);
  });

  it("an enable-only row has no definition; clearing a definition keeps enabled", async () => {
    const r = await upsertTypeEnabled(T, "ann", "proposal", "override", false);
    expect(r).toMatchObject({ definition: null, enabled: false, origin: "override" });
    await upsertTypeDefinition(T, "ann", "override", def({ key: "proposal" }));
    expect((await getTypeRow(T, "proposal"))?.enabled).toBe(false);
    expect(await clearTypeDefinition(T, "ann", "proposal")).toMatchObject({ definition: null, enabled: false });
    expect(await clearTypeDefinition(T, "ann", "missing")).toBeNull();
  });
});
