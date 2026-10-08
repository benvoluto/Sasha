import { describe, expect, it, vi } from "vitest";
import type { DocumentTypeRow } from "./store";

const row = (over: Partial<DocumentTypeRow>): DocumentTypeRow => ({
  team_id: "org:a",
  key: "x",
  origin: "team",
  version: 1,
  title: "",
  family: "general",
  summary: "",
  definition: null,
  provenance: null,
  enabled: true,
  created_by: "ann",
  updated_by: "ann",
  created_at: "2026-10-07T00:00:00.000Z",
  updated_at: "2026-10-07T00:00:00.000Z",
  ...over,
});

vi.mock("./store", () => ({
  listTypeRows: async () => [
    row({ key: "proposal", origin: "override", definition: { title: "broken override" } }),
    row({ key: "broken-team", definition: { key: "broken-team", sections: "nope" } }),
  ],
}));

import { getType, listTypes } from "./index";
import { fileTypeByKey } from "./files";

describe("invalid stored rows", () => {
  it("are skipped with a console error and never break the list", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const all = await listTypes("org:a", { includeDisabled: true });
    expect(all.some((e) => e.definition.key === "broken-team")).toBe(false);
    const p = await getType("org:a", "proposal");
    expect(p).toMatchObject({ overridden: true, enabled: true });
    expect(p?.definition).toEqual(fileTypeByKey("proposal"));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
