import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The other store tests run on the in-memory fallback; these check the SQL that
// listSources builds by hand (placeholders, team scoping, ILIKE escaping).
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@vercel/postgres", () => ({ sql: Object.assign(vi.fn(async () => ({ rows: [], rowCount: 0 })), { query: mocks.query }) }));
vi.mock("@/lib/ontology/ensure-schema", () => ({ ensureSchema: async () => {} }));

import { listSources } from "./store";

const FOLDER = "0b6f1c1e-7a5d-4c39-9a0e-2f4f3d1b8c11";
const DOC = "6d1e4b8a-2c3f-4e5a-8b7c-9d0e1f2a3b4c";

describe("listSources SQL", () => {
  beforeEach(() => {
    process.env.POSTGRES_URL = "postgres://test";
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    delete process.env.POSTGRES_URL;
  });

  it("numbers its placeholders in order and always scopes to the team", async () => {
    await listSources("org:a", { folder: FOLDER, kind: "url", ids: [FOLDER, "not-a-uuid"], documentId: DOC, query: "plan", limit: 10 });
    const [text, params] = mocks.query.mock.calls[0];
    expect(text).toContain("WHERE s.team_id = $1 AND s.folder_id = $2::uuid AND s.kind = $3 AND s.id = ANY($4::uuid[])");
    expect(text).toContain("ds.document_id = $5::uuid");
    expect(text).toContain("s.title ILIKE $6");
    expect(text).toMatch(/LIMIT \$7$/);
    expect(params).toEqual(["org:a", FOLDER, "url", [FOLDER], DOC, "%plan%", 10]);
  });

  it("escapes LIKE wildcards in the search text", async () => {
    await listSources("org:a", { query: "50%_off\\" });
    const [, params] = mocks.query.mock.calls[0];
    expect(params[1]).toBe("%50\\%\\_off\\\\%");
  });

  it("filters to the root folder without a parameter, and skips the query for bad ids", async () => {
    await listSources("org:a", { folder: "root" });
    const [text, params] = mocks.query.mock.calls[0];
    expect(text).toContain("s.team_id = $1 AND s.folder_id IS NULL");
    expect(params).toEqual(["org:a", 200]);

    expect(await listSources("org:a", { folder: "nope" })).toEqual([]);
    expect(await listSources("org:a", { ids: ["nope"] })).toEqual([]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
