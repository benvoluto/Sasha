import { afterEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ upload: blob.upload }));

import { KEPT_FOR_LATER, uploadProblems, uploadSourceFiles } from "./upload";

// The dropzone hands `!uploadProblems(...)` to its host as `complete`, and the
// hosts close the dropzone only then: a partial upload must leave a message.
describe("uploadProblems", () => {
  it("is null only when every file made it", () => {
    expect(uploadProblems([], null)).toBeNull();
  });

  it("reports files that failed after others succeeded", () => {
    expect(uploadProblems([{ name: "b.pdf", error: "Upload not found." }], null)).toBe("Couldn't upload b.pdf: Upload not found.");
  });

  it("keeps the picker's rejection message alongside failures", () => {
    const rejected = "c.zip: not a supported type.";
    expect(uploadProblems([], rejected)).toBe(rejected);
    expect(uploadProblems([{ name: "b.pdf", error: "Upload not found." }], rejected)).toBe(`${rejected} Couldn't upload b.pdf: Upload not found.`);
  });
});

describe("uploadSourceFiles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    blob.upload.mockReset();
  });

  // The files are already in Blob by then: deleting them threw away a whole upload; retry adopts them instead.
  it("shows the server's rate-limit sentence when completing is refused, and keeps the uploaded files for Read again", async () => {
    const limited = "You've used your 60 source reads for this hour. Try again in 5 min.";
    const calls: Array<[string, string]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init?.method ?? "GET"]);
        if (url === "/api/upload/presign") return Response.json({ uploads: [{ sourceId: "s1", fileName: "a.pdf", fields: { blobPath: "sources/x/a.pdf", contentType: "application/pdf" } }] });
        if (url === "/api/upload/complete") return Response.json({ error: limited, code: "rate_limited", scope: "user", family: "ingest", retry_after_seconds: 300 }, { status: 429 });
        return new Response(null, { status: 204 });
      }),
    );
    blob.upload.mockResolvedValue({ url: "https://x.blob/a.pdf", pathname: "sources/x/a-1.pdf" });
    await expect(uploadSourceFiles([new File(["%PDF"], "a.pdf", { type: "application/pdf" })], {})).rejects.toThrow(`${limited} ${KEPT_FOR_LATER}`);
    expect(calls.some(([, method]) => method === "DELETE")).toBe(false);
  });

  it("removes the stranded rows when completing fails for any other reason", async () => {
    const calls: Array<[string, string]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init?.method ?? "GET"]);
        if (url === "/api/upload/presign") return Response.json({ uploads: [{ sourceId: "s1", fileName: "a.pdf", fields: { blobPath: "sources/x/a.pdf", contentType: "application/pdf" } }] });
        if (url === "/api/upload/complete") return Response.json({ error: "Invalid upload report." }, { status: 400 });
        return new Response(null, { status: 204 });
      }),
    );
    blob.upload.mockResolvedValue({ url: "https://x.blob/a.pdf", pathname: "sources/x/a-1.pdf" });
    await expect(uploadSourceFiles([new File(["%PDF"], "a.pdf", { type: "application/pdf" })], {})).rejects.toThrow("Invalid upload report.");
    expect(calls).toContainEqual(["/api/sources/s1", "DELETE"]);
  });
});
