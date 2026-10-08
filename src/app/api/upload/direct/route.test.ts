import { beforeEach, describe, expect, it, vi } from "vitest";

// handleUpload is stood in for by a call straight to onBeforeGenerateToken, so
// these tests exercise the route's own gate: which uploads get a token.
const mocks = vi.hoisted(() => ({ caller: { teamId: "org:a", agent: "ann", permissions: [] as string[] } as unknown }));
vi.mock("@vercel/blob/client", () => ({
  handleUpload: async ({ body, onBeforeGenerateToken }: { body: { payload: { pathname: string; clientPayload: string | null } }; onBeforeGenerateToken: (p: string, c: string | null) => Promise<unknown> }) =>
    ({ token: await onBeforeGenerateToken(body.payload.pathname, body.payload.clientPayload) }),
}));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => mocks.caller }));

import { NextResponse } from "next/server";
import { resetMemoryStore } from "@/lib/documents/store";
import { sourceBlobPath } from "@/lib/sources/blob-paths";
import { createSource, resetSourceStore, setSourceStatus } from "@/lib/sources/store";
import { POST } from "./route";

async function presigned(team = "org:a", name = "a.pdf") {
  const id = crypto.randomUUID();
  const path = sourceBlobPath(team, id, name);
  await createSource(team, "ann", { id, kind: "file", filename: name, mime: "application/pdf", bytes: 5, blob_pathname: path, extraction_status: "uploading" });
  return { id, path };
}

const token = (pathname: string, sourceId: unknown) =>
  POST(
    new Request("http://x/api/upload/direct", {
      method: "POST",
      body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, clientPayload: JSON.stringify({ sourceId }), multipart: false } }),
    }),
  );

describe("POST /api/upload/direct", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    resetSourceStore();
    mocks.caller = { teamId: "org:a", agent: "ann", permissions: [] };
  });

  it("issues a token for the caller's uploading source at its presigned path", async () => {
    const { id, path } = await presigned();
    const res = await token(path, id);
    expect(res.status).toBe(200);
    const { token: t } = await res.json();
    expect(t).toMatchObject({ allowedContentTypes: ["application/pdf"], addRandomSuffix: true, allowOverwrite: false });
    expect(JSON.parse(t.tokenPayload)).toEqual({ sourceId: id, teamId: "org:a" });
  });

  it("refuses another team's source", async () => {
    const { id, path } = await presigned("org:b");
    const res = await token(path, id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Upload not found.");
  });

  it("refuses a source that already finished uploading", async () => {
    const { id, path } = await presigned();
    await setSourceStatus("org:a", id, "pending");
    const res = await token(path, id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This file has already been uploaded.");
  });

  it("refuses any path but the presigned one", async () => {
    const { id, path } = await presigned();
    const other = await presigned("org:a", "b.pdf");
    for (const p of [other.path, path.replace(/a\.pdf$/, "evil.pdf"), "upload-groups/x/files/0-a.pdf"]) {
      const res = await token(p, id);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid upload path.");
    }
  });

  it("refuses a missing source id and a signed-out caller", async () => {
    const { path } = await presigned();
    expect((await (await token(path, undefined)).json()).error).toBe("Missing upload details.");
    mocks.caller = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    const { id, path: p2 } = await presigned();
    expect((await (await token(p2, id)).json()).error).toBe("Sign in to upload.");
  });
});
