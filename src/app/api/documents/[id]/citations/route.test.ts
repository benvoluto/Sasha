import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const team = vi.hoisted(() => ({ caller: { teamId: "org:a", agent: "ann" } as { teamId: string; agent: string } | null, permission: "" }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => {
    team.permission = permission;
    return team.caller ?? NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  },
}));

import { createDocument, resetMemoryStore } from "@/lib/documents/store";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { passagePrefix } from "@/lib/sources/pages";
import { createSource, linkSource, replacePassages, resetSourceStore, unlinkSource } from "@/lib/sources/store";
import { GET } from "./route";

const get = (id: string) => GET(new Request(`http://x/api/documents/${id}/citations`), { params: Promise.resolve({ id }) });

describe("GET /api/documents/[id]/citations", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    team.caller = { teamId: "org:a", agent: "ann" };
  });

  async function citedDoc(teamId: string) {
    const s = await createSource(teamId, "ann", { kind: "note", title: "Q3 Report", extracted_text: "Demand rose.", extraction_status: "ready" });
    const id = `${passagePrefix(s.id)}.P0`;
    await replacePassages(teamId, s.id, [{ id, idx: 0, page: 4, start_offset: 0, end_offset: 12, text: "Demand rose." }]);
    const d = await createDocument(teamId, "ann", {
      content_json: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Demand rose.", marks: [{ type: "citation", attrs: { kind: "passage", passageId: id, sourceId: s.id, verified: true } }] }] }] },
    });
    await linkSource(teamId, "ann", d.id, s.id);
    return { d, s, id };
  }

  it("returns the resolved references and flags an unlinked source, with read permission and no caching", async () => {
    const { d, s, id } = await citedDoc("org:a");
    const res = await get(d.id);
    expect(team.permission).toBe(PERMISSIONS.documentRead);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.references).toMatchObject([{ key: `p:${id}`, number: 1, status: "ok", sourceTitle: "Q3 Report", page: 4, excerpt: "Demand rose." }]);
    expect(body.problems).toEqual([]);

    await unlinkSource("org:a", d.id, s.id);
    expect((await (await get(d.id)).json()).problems).toEqual([{ key: `p:${id}`, number: 1, status: "unlinked", sourceTitle: "Q3 Report" }]);
  });

  it("404s another team's document and a bad id, and passes the auth refusal through", async () => {
    const { d } = await citedDoc("org:b");
    expect((await get(d.id)).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
    team.caller = null;
    expect((await get(d.id)).status).toBe(401);
  });
});
