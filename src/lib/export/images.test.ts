import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sources = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/sources/store", () => ({
  getSource: async (teamId: string, id: string) => sources.get(`${teamId}/${id}`) ?? null,
}));

import { decodeDataImage, imageSize, ownSourceFileId, resolveImages, sniffImage } from "./images";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = new Uint8Array(Buffer.from(PNG_B64, "base64"));
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00, 0, 0]);
// A minimal JPEG prefix: SOI, an APP0 segment, then SOF0 with height 0x0102, width 0x0304.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x02, 0x03, 0x04, 0x03, 0, 0, 0, 0]);
const STORE = "teststore";
const BLOB = `https://${STORE}.public.blob.vercel-storage.com/a.png`;
const ORIGIN = "https://sasha.app";
const doc = (...srcs: string[]) => ({ type: "doc", content: srcs.map((src) => ({ type: "image", attrs: { src, alt: "x" } })) });

describe("image helpers", () => {
  it("sniffs types from bytes and reads sizes from headers", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(imageSize(PNG, "image/png")).toEqual({ width: 1, height: 1 });
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(imageSize(GIF, "image/gif")).toEqual({ width: 32, height: 16 });
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(imageSize(JPEG, "image/jpeg")).toEqual({ width: 0x0304, height: 0x0102 });
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(sniffImage(new TextEncoder().encode("<html><script>"))).toBeNull();
  });

  it("decodes data images only when the bytes match the claimed type", () => {
    expect(decodeDataImage(`data:image/png;base64,${PNG_B64}`)?.mime).toBe("image/png");
    expect(decodeDataImage("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E")?.mime).toBe("image/svg+xml");
    expect(decodeDataImage(`data:image/jpeg;base64,${PNG_B64}`)).toBeNull();
    expect(decodeDataImage("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(decodeDataImage("data:image/svg+xml,%3Cscript%3E")).toBeNull();
  });

  it("recognizes only our own source file route, relative or on this origin", () => {
    expect(ownSourceFileId("/api/sources/abc-1/file", ORIGIN)).toBe("abc-1");
    expect(ownSourceFileId(`${ORIGIN}/api/sources/abc/file`, ORIGIN)).toBe("abc");
    expect(ownSourceFileId("https://evil.example/api/sources/abc/file", ORIGIN)).toBeNull();
    expect(ownSourceFileId("/api/sources/abc/file/../../x", ORIGIN)).toBeNull();
    expect(ownSourceFileId("/api/documents/abc", ORIGIN)).toBeNull();
  });
});

describe("resolveImages", () => {
  const fetchMock = vi.fn();
  let token: string | undefined;
  beforeEach(() => {
    token = process.env.BLOB_READ_WRITE_TOKEN;
    process.env.BLOB_READ_WRITE_TOKEN = `vercel_blob_rw_${STORE}_notasecret`;
    sources.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    if (token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = token;
    vi.unstubAllGlobals();
  });

  it("keeps data images and never fetches external URLs", async () => {
    const data = `data:image/png;base64,${PNG_B64}`;
    const out = await resolveImages(doc(data, "https://evil.example/a.png", "/api/other"), { teamId: "org:a", origin: ORIGIN });
    expect(out.get(data)?.width).toBe(1);
    expect(out.get("https://evil.example/a.png")).toBeNull();
    expect(out.get("/api/other")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("inlines the team's own source image from our Blob store, and nobody else's", async () => {
    sources.set("org:a/s1", { id: "s1", blob_url: BLOB, mime: "image/png", bytes: PNG.length });
    sources.set("org:a/s2", { id: "s2", blob_url: "https://evil.example/a.png", mime: "image/png", bytes: 10 });
    sources.set("org:a/s3", { id: "s3", blob_url: BLOB, mime: "application/pdf", bytes: 10 });
    fetchMock.mockImplementation(async () => new Response(PNG, { status: 200, headers: { "content-length": String(PNG.length) } }));
    const out = await resolveImages(doc("/api/sources/s1/file", "/api/sources/s2/file", "/api/sources/s3/file", "/api/sources/s4/file"), { teamId: "org:a", origin: ORIGIN });
    expect(out.get("/api/sources/s1/file")?.dataUri).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(out.get("/api/sources/s2/file")).toBeNull();
    expect(out.get("/api/sources/s3/file")).toBeNull();
    expect(out.get("/api/sources/s4/file")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(BLOB);
    // Another team asking for the same id gets nothing.
    const other = await resolveImages(doc("/api/sources/s1/file"), { teamId: "org:b", origin: ORIGIN });
    expect(other.get("/api/sources/s1/file")).toBeNull();
  });

  it("writes alt text for images past the total size cap", async () => {
    const a = `data:image/png;base64,${PNG_B64}`;
    const b = `data:image/gif;base64,${Buffer.from(GIF).toString("base64")}`;
    const out = await resolveImages(doc(a, b), { teamId: "org:a", origin: ORIGIN, maxBytes: PNG.length + 2 });
    expect(out.get(a)).not.toBeNull();
    expect(out.get(b)).toBeNull();
  });
});
