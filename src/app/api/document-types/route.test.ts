import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissionsForRole } from "@/lib/ontology/permissions";

const caller = vi.hoisted(() => ({ current: { teamId: "org:a", agent: "ann", userId: "u", orgId: "a", permissions: [] as string[] } }));
vi.mock("@/lib/documents/team", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireTeam: async (permission: string) =>
      caller.current.permissions.includes(permission) ? caller.current : NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 }),
  };
});

import { resetCatalogStore } from "@/catalog/store";
import { minimalType } from "@/catalog/test-fixtures";
import { resetMemoryStore, createDocument } from "@/lib/documents/store";
import { DELETE, GET as GET_ONE, PATCH, PUT } from "./[key]/route";
import { POST as FROM_DOCUMENT } from "./from-document/route";
import { GET, POST } from "./route";

const as = (role: "admin" | "member") => (caller.current = { ...caller.current, permissions: permissionsForRole(role) });
const json = (method: string, body: unknown, url = "http://x/api/document-types") =>
  new Request(url, { method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetCatalogStore();
  resetMemoryStore();
  as("admin");
});

describe("GET /api/document-types", () => {
  it("lists enabled types for members; ?all=1 is admin only and includes disabled", async () => {
    as("admin");
    expect((await PATCH(json("PATCH", { enabled: false }), ctx("proposal"))).status).toBe(200);
    as("member");
    const res = await GET(new Request("http://x/api/document-types"));
    expect(res.status).toBe(200);
    const { types } = await res.json();
    expect(types.some((t: { key: string }) => t.key === "general-report")).toBe(true);
    expect(types.some((t: { key: string }) => t.key === "proposal")).toBe(false);
    expect((await GET(new Request("http://x/api/document-types?all=1"))).status).toBe(403);
    as("admin");
    const all = await (await GET(new Request("http://x/api/document-types?all=1"))).json();
    expect(all.types.find((t: { key: string }) => t.key === "proposal")).toMatchObject({ enabled: false, origin: "file" });
  });
});

describe("POST /api/document-types", () => {
  it("creates a team type (201), 409 on clash, 400 with issues on invalid, 403 for members", async () => {
    const res = await POST(json("POST", { definition: minimalType() }));
    expect(res.status).toBe(201);
    expect((await res.json()).type).toMatchObject({ key: "team-brief", origin: "team", sections: [{ key: "ask" }, { key: "context" }] });
    expect((await POST(json("POST", { definition: minimalType() }))).status).toBe(409);
    expect((await POST(json("POST", { definition: minimalType({ key: "proposal" }) }))).status).toBe(409);
    const bad = await POST(json("POST", { definition: { ...minimalType({ key: "other" }), sections: [] } }));
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.issues[0]).toMatch(/^sections: /);
    expect(typeof body.error).toBe("string");
    expect((await POST(json("POST", "{oops"))).status).toBe(400);
    as("member");
    expect((await POST(json("POST", { definition: minimalType({ key: "x-2" }) }))).status).toBe(403);
  });
});

describe("/api/document-types/[key]", () => {
  it("GET resolves aliases, reports editability, 404s unknown keys", async () => {
    const res = await GET_ONE(new Request("http://x"), ctx("general_report"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type.key).toBe("general-report");
    expect(body.meta).toMatchObject({ origin: "file", enabled: true, overridden: false, editable: true });
    as("member");
    expect((await (await GET_ONE(new Request("http://x"), ctx("proposal"))).json()).meta.editable).toBe(false);
    expect((await GET_ONE(new Request("http://x"), ctx("nope"))).status).toBe(404);
  });

  it("PUT overrides a file type with a bumped version; key mismatch 400; members 403", async () => {
    const def = (await (await GET_ONE(new Request("http://x"), ctx("proposal"))).json()).type;
    const res = await PUT(json("PUT", { definition: { ...def, title: "Our proposal" } }), ctx("proposal"));
    expect(res.status).toBe(200);
    expect((await res.json()).type).toMatchObject({ title: "Our proposal", overridden: true, version: def.version + 1 });
    const mismatch = await PUT(json("PUT", { definition: { ...def, key: "general-report" } }), ctx("proposal"));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).issues).toHaveLength(1);
    const invalid = await PUT(json("PUT", { definition: { ...def, family: "nope" } }), ctx("proposal"));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).issues[0]).toMatch(/^family: /);
    expect((await PUT(json("PUT", { definition: minimalType({ key: "ghost" }) }), ctx("ghost"))).status).toBe(404);
    as("member");
    expect((await PUT(json("PUT", { definition: def }), ctx("proposal"))).status).toBe(403);
  });

  it("PATCH toggles enabled; DELETE reverts overrides and deletes team types", async () => {
    expect((await PATCH(json("PATCH", { enabled: "yes" }), ctx("proposal"))).status).toBe(400);
    expect((await PATCH(json("PATCH", { enabled: true }), ctx("nope"))).status).toBe(404);
    expect((await DELETE(new Request("http://x"), ctx("proposal"))).status).toBe(404);
    const def = (await (await GET_ONE(new Request("http://x"), ctx("proposal"))).json()).type;
    await PUT(json("PUT", { definition: { ...def, title: "Ours" } }), ctx("proposal"));
    expect((await DELETE(new Request("http://x"), ctx("proposal"))).status).toBe(200);
    expect((await (await GET_ONE(new Request("http://x"), ctx("proposal"))).json()).type.title).toBe(def.title);
    await POST(json("POST", { definition: minimalType() }));
    expect(await (await DELETE(new Request("http://x"), ctx("team-brief"))).json()).toEqual({ ok: true });
    expect((await GET_ONE(new Request("http://x"), ctx("team-brief"))).status).toBe(404);
  });
});

describe("POST /api/document-types/from-document", () => {
  it("saves the document's top headings as a team type with a derived, unique key", async () => {
    as("member");
    const doc = await createDocument("org:a", "ann", {
      title: "Plan",
      content_json: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2, sectionId: "s_1", specKey: null }, content: [{ type: "text", text: "Why Now" }] },
          { type: "heading", attrs: { level: 3, sectionId: "s_2", specKey: null }, content: [{ type: "text", text: "Detail" }] },
          { type: "heading", attrs: { level: 2, sectionId: "s_3", specKey: null }, content: [{ type: "text", text: "Plan" }] },
        ],
      },
    });
    const res = await FROM_DOCUMENT(json("POST", { documentId: doc.id, title: "General Report" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toMatchObject({ key: "general-report-2", origin: "team", family: "general" });
    expect(body.specKeys).toEqual({ s_1: "why-now", s_3: "plan" });
  });

  it("400 without headings or with a bad body, 404 for another team's document", async () => {
    const empty = await createDocument("org:a", "ann", {});
    expect((await FROM_DOCUMENT(json("POST", { documentId: empty.id, title: "X" }))).status).toBe(400);
    expect((await FROM_DOCUMENT(json("POST", { documentId: "not-a-uuid", title: "X" }))).status).toBe(400);
    const other = await createDocument("org:b", "bob", {});
    expect((await FROM_DOCUMENT(json("POST", { documentId: other.id, title: "X" }))).status).toBe(404);
  });
});
