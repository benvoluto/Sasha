import { afterEach, describe, expect, it, vi } from "vitest";
import { getMimeTypeFromExtension, resumableUpload } from "./resumable-upload";

const META = { file: { displayName: "WJ-ACH.pdf", mimeType: "application/pdf" } };
const URL_ = "https://upload.example/resumable";

type Call = { url: string; init: RequestInit };

/**
 * Stand in for the Google upload endpoint: records every request, hands back an
 * upload URL on start, and finalizes when told to.
 */
function installFetch(opts: { initOk?: boolean; uploadUrl?: string | null; chunkOk?: boolean; fileBody?: unknown } = {}) {
  const calls: Call[] = [];
  const chunks: Uint8Array[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === URL_) {
      if (opts.initOk === false) return new Response("nope", { status: 403 });
      const headers = new Headers();
      const uploadUrl = opts.uploadUrl === undefined ? "https://upload.example/session" : opts.uploadUrl;
      if (uploadUrl) headers.set("x-goog-upload-url", uploadUrl);
      return new Response("{}", { status: 200, headers });
    }
    if (opts.chunkOk === false) return new Response("bad chunk", { status: 400 });
    chunks.push(init.body as Uint8Array);
    const command = (init.headers as Record<string, string>)["X-Goog-Upload-Command"];
    if (!command.includes("finalize")) return new Response("", { status: 200 });
    const body = opts.fileBody ?? { file: { name: "files/abc", uri: "gs://abc", mimeType: "application/pdf", state: "PROCESSING" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, chunks };
}

afterEach(() => vi.unstubAllGlobals());

const bytes = (n: number) => new Uint8Array(n).fill(7);

describe("resumableUpload", () => {
  it("declares the length it actually sends", async () => {
    const { calls } = installFetch();
    await resumableUpload({ data: bytes(1234), resumableUrl: URL_, metadata: META });
    const start = calls[0].init.headers as Record<string, string>;
    expect(start["X-Goog-Upload-Header-Content-Length"]).toBe("1234");
  });

  it("finalizes a single-chunk upload and returns the file", async () => {
    installFetch();
    const result = await resumableUpload({ data: bytes(500), resumableUrl: URL_, metadata: META });
    expect(result.file.uri).toBe("gs://abc");
  });

  // The old loop uploaded a full chunk, fell through to its `done` break, and
  // threw "no result received" with bytes still unsent.
  it("sends every byte of a multi-chunk file and finalizes on the last", async () => {
    const { calls, chunks } = installFetch();
    await resumableUpload({ data: bytes(2500), resumableUrl: URL_, metadata: META, chunkSize: 1000 });
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(2500);
    const commands = calls.slice(1).map((c) => (c.init.headers as Record<string, string>)["X-Goog-Upload-Command"]);
    expect(commands).toEqual(["upload", "upload", "upload, finalize"]);
  });

  it("sends offsets that match the bytes already sent", async () => {
    const { calls } = installFetch();
    await resumableUpload({ data: bytes(2500), resumableUrl: URL_, metadata: META, chunkSize: 1000 });
    const offsets = calls.slice(1).map((c) => (c.init.headers as Record<string, string>)["X-Goog-Upload-Offset"]);
    expect(offsets).toEqual(["0", "1000", "2000"]);
  });

  // A file whose size is an exact multiple of the chunk size used to leave the
  // loop with an empty buffer and never finalize.
  it("finalizes when the size is an exact multiple of the chunk size", async () => {
    const { chunks } = installFetch();
    const result = await resumableUpload({ data: bytes(2000), resumableUrl: URL_, metadata: META, chunkSize: 1000 });
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000]);
    expect(result.file.uri).toBe("gs://abc");
  });

  it("refuses an empty file instead of opening a session for it", async () => {
    const { calls } = installFetch();
    await expect(resumableUpload({ data: bytes(0), resumableUrl: URL_, metadata: META })).rejects.toThrow(/empty/i);
    expect(calls).toHaveLength(0);
  });

  it("reports the status and body when the session cannot be opened", async () => {
    installFetch({ initOk: false });
    await expect(resumableUpload({ data: bytes(10), resumableUrl: URL_, metadata: META })).rejects.toThrow(/403 nope/);
  });

  it("reports the failing offset when a chunk is rejected", async () => {
    installFetch({ chunkOk: false });
    await expect(
      resumableUpload({ data: bytes(10), resumableUrl: URL_, metadata: META }),
    ).rejects.toThrow(/byte 0: 400 bad chunk/);
  });

  it("fails clearly when no upload URL comes back", async () => {
    installFetch({ uploadUrl: null });
    await expect(resumableUpload({ data: bytes(10), resumableUrl: URL_, metadata: META })).rejects.toThrow(/upload URL/i);
  });

  it("fails clearly when finalize returns no file reference", async () => {
    installFetch({ fileBody: { file: {} } });
    await expect(resumableUpload({ data: bytes(10), resumableUrl: URL_, metadata: META })).rejects.toThrow(/no file reference/i);
  });
});

describe("getMimeTypeFromExtension", () => {
  it("maps the formats the app accepts", () => {
    expect(getMimeTypeFromExtension("WJ-ACH.pdf")).toBe("application/pdf");
    expect(getMimeTypeFromExtension("report.DOCX")).toContain("wordprocessingml");
    expect(getMimeTypeFromExtension("notes")).toBe("application/octet-stream");
  });
});
