import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ denied: false, permission: "" }));
vi.mock("@/lib/documents/team", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireTeam: async (permission: string) => {
      auth.permission = permission;
      return auth.denied ? NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 }) : { teamId: "org:a", agent: "ann" };
    },
  };
});
vi.mock("@/catalog", () => ({
  getType: async (_team: string, key: string | null) => (key === "memo" ? { definition: { key: "memo", title: "Memo" } } : null),
}));
const renderPdf = vi.fn();
vi.mock("@/lib/export/pdf", async (orig) => ({ ...(await orig<typeof import("@/lib/export/pdf")>()), renderPdf: (html: string) => renderPdf(html) }));

import { createDocument, resetMemoryStore, updateDocument } from "@/lib/documents/store";
import { EXPORT_HTML_CSP, MAX_EXPORT_JSON_BYTES } from "@/lib/export/contract";
import { resetLimiter } from "@/lib/limits/limiter";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { PdfBusyError, PdfTooLargeError, PdfUnavailableError } from "@/lib/export/pdf";
import { GET } from "./route";

const call = (id: string, query: string) => GET(new Request(`https://sasha.app/api/documents/${id}/export?${query}`), { params: Promise.resolve({ id }) });

const content = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Findings" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Demand rose.", marks: [{ type: "citation", attrs: { kind: "passage", passageId: "S1a2b3c4d.P1", sourceId: "gone", verified: true } }] },
        { type: "text", text: " <script>alert(1)</script>" },
      ],
    },
  ],
};

async function memo(team = "org:a") {
  const d = await createDocument(team, "ann", { title: "Q3 memo / final", type_key: "memo" });
  await updateDocument(team, d.id, "ann", { content_json: content } as never);
  return d;
}

describe("GET /api/documents/[id]/export", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    renderPdf.mockReset();
    auth.denied = false;
  });

  it("requires documentRead and refuses a caller without it", async () => {
    const d = await memo();
    auth.denied = true;
    expect((await call(d.id, "format=md")).status).toBe(403);
    expect(auth.permission).toBe(PERMISSIONS.documentRead);
  });

  it("400s a bad format and 404s another team's document", async () => {
    const d = await memo();
    expect((await call(d.id, "format=exe")).status).toBe(400);
    expect((await call(d.id, "")).status).toBe(400);
    const other = await memo("org:b");
    const res = await call(other.id, "format=md");
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("413s a stored document over the size limit", async () => {
    const d = await createDocument("org:a", "ann", { title: "Big" });
    const big = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(MAX_EXPORT_JSON_BYTES) }] }] };
    await updateDocument("org:a", d.id, "ann", { content_json: big } as never);
    expect((await call(d.id, "format=md")).status).toBe(413);
  });

  it("exports Markdown as an attachment with the citation and the References", async () => {
    const d = await memo();
    const res = await call(d.id, "format=md");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="Q3 memo final.md"; filename*=UTF-8''Q3%20memo%20final.md`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    expect(text.startsWith("# Q3 memo / final\n\n## Findings\n\nDemand rose.[\\[1\\]][1]")).toBe(true);
    expect(text).toContain("1. Deleted source");
    expect(text).toContain("\\<script\\>");
  });

  it("exports Word with the type in the properties", async () => {
    const d = await memo();
    const res = await call(d.id, "format=docx");
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(await zip.file("docProps/core.xml")!.async("string")).toContain("<dc:subject>Memo</dc:subject>");
    expect(await zip.file("word/document.xml")!.async("string")).toContain("<w:footnoteReference ");
  });

  it("serves html inline under the strict CSP, with document text escaped", async () => {
    const d = await memo();
    const res = await call(d.id, "format=html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(EXPORT_HTML_CSP);
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; /);
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain('<sup class="cite"><a href="#ref-1">1</a></sup>');
  });

  it("maps PdfUnavailableError to 503 with the print fallback, and an oversized PDF to 413", async () => {
    const d = await memo();
    renderPdf.mockRejectedValueOnce(new PdfUnavailableError());
    const res = await call(d.id, "format=pdf");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ fallback: "print" });
    renderPdf.mockRejectedValueOnce(new PdfTooLargeError());
    expect((await call(d.id, "format=pdf")).status).toBe(413);
  });

  it("returns the rendered PDF as an attachment", async () => {
    const d = await memo();
    renderPdf.mockResolvedValueOnce(Buffer.from("%PDF-1.7 test"));
    const res = await call(d.id, "format=pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain('filename="Q3 memo final.pdf"');
    expect(renderPdf.mock.calls[0][0]).toContain("<!doctype html>");
  });

  it("maps a full render queue to 429 with Retry-After", async () => {
    const d = await memo();
    renderPdf.mockRejectedValueOnce(new PdfBusyError());
    const res = await call(d.id, "format=pdf");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("shares one render between identical concurrent PDF exports, and renders again once it is done", async () => {
    const d = await memo();
    let finish!: (b: Buffer) => void;
    renderPdf.mockImplementationOnce(() => new Promise<Buffer>((r) => (finish = r)));
    const a = call(d.id, "format=pdf");
    const b = call(d.id, "format=pdf");
    await vi.waitFor(() => expect(renderPdf).toHaveBeenCalledTimes(1));
    finish(Buffer.from("%PDF-1.7 shared"));
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await rb.text()).toBe("%PDF-1.7 shared");
    expect(renderPdf).toHaveBeenCalledTimes(1);
    renderPdf.mockResolvedValueOnce(Buffer.from("%PDF-1.7 again"));
    expect(await (await call(d.id, "format=pdf")).text()).toBe("%PDF-1.7 again");
    expect(renderPdf).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/documents/[id]/export rate limit", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    process.env.SASHA_LIMIT_EXPORT_USER = "1/10m";
    resetMemoryStore();
    resetLimiter();
    renderPdf.mockReset();
  });
  afterEach(() => {
    delete process.env.SASHA_LIMIT_EXPORT_USER;
  });

  it("counts PDF renders only, refusing before the render with Retry-After", async () => {
    const d = await memo();
    expect((await call(d.id, "format=md")).status).toBe(200);
    expect((await call(d.id, "format=docx")).status).toBe(200);
    renderPdf.mockResolvedValue(Buffer.from("%PDF-1.7 test"));
    expect((await call(d.id, "format=pdf")).status).toBe(200);
    const res = await call(d.id, "format=pdf");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.json()).toMatchObject({ code: "rate_limited", scope: "user", family: "export", error: expect.stringMatching(/^You've used your 1 PDF export for the last 10 minutes\. Try again in \d+ min\.$/) });
    expect(renderPdf).toHaveBeenCalledTimes(1);
  });

  it("gives the call back when no PDF could be made (no browser, full queue), so the print fallback keeps showing", async () => {
    const d = await memo();
    renderPdf.mockRejectedValueOnce(new PdfUnavailableError()).mockRejectedValueOnce(new PdfUnavailableError()).mockRejectedValueOnce(new PdfBusyError());
    expect((await call(d.id, "format=pdf")).status).toBe(503);
    expect((await call(d.id, "format=pdf")).status).toBe(503);
    expect((await call(d.id, "format=pdf")).status).toBe(429);
    renderPdf.mockResolvedValue(Buffer.from("%PDF-1.7 test"));
    expect((await call(d.id, "format=pdf")).status).toBe(200);
    expect(renderPdf).toHaveBeenCalledTimes(4);
  });

  it("keeps a timed-out or oversized render charged", async () => {
    const d = await memo();
    renderPdf.mockRejectedValueOnce(new PdfTooLargeError());
    expect((await call(d.id, "format=pdf")).status).toBe(413);
    const res = await call(d.id, "format=pdf");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    expect(renderPdf).toHaveBeenCalledTimes(1);
  });
});
