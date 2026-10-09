import { describe, expect, it, vi } from "vitest";
import { exportErrorMessage, exportUrl, fetchExport, filenameFromDisposition, isPrintFallback, MENU_FORMATS, MENU_ITEM_LABEL } from "./export-menu-model";

describe("export menu model", () => {
  it("offers Markdown, Word and PDF, never the html fallback", () => {
    expect(MENU_FORMATS).toEqual(["md", "docx", "pdf"]);
    expect(exportUrl("a b", "pdf")).toBe("/api/documents/a%20b/export?format=pdf");
  });

  it("takes the filename from filename*, then filename, then the title", () => {
    expect(filenameFromDisposition(`attachment; filename="R_sum_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`, "x", "pdf")).toBe("Résumé.pdf");
    expect(filenameFromDisposition(`attachment; filename="Plain name.docx"`, "x", "docx")).toBe("Plain name.docx");
    expect(filenameFromDisposition("attachment; filename=bare.md", "x", "md")).toBe("bare.md");
    expect(filenameFromDisposition(null, "My memo", "md")).toBe("My memo.md");
    expect(filenameFromDisposition("attachment", "My memo", "docx")).toBe("My memo.docx");
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4`, "Fallback", "pdf")).toBe("Fallback.pdf");
  });

  it("strips path separators and control characters from the name", () => {
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`, "x", "md")).toBe("etc passwd");
    expect(filenameFromDisposition(`attachment; filename="a\\\\b.md"`, "x", "md")).toBe("a b.md");
  });

  it("recognizes the print fallback only on a 503 that asks for it", () => {
    expect(isPrintFallback(503, { error: "x", fallback: "print" })).toBe(true);
    expect(isPrintFallback(503, { error: "x" })).toBe(false);
    expect(isPrintFallback(500, { fallback: "print" })).toBe(false);
    expect(isPrintFallback(503, null)).toBe(false);
  });

  it("says what went wrong", () => {
    expect(exportErrorMessage(413, "docx", null)).toBe("This document is too large to export as Word.");
    expect(exportErrorMessage(404, "md", null)).toMatch(/wasn't found/);
    expect(exportErrorMessage(500, "pdf", { error: "The PDF export failed." })).toBe("The PDF export failed.");
    expect(exportErrorMessage(502, "md", { error: 42 })).toBe("The Markdown export failed. Try again.");
    // A rate limit shows the server's sentence as is.
    const limited = "You've used your 20 PDF exports for the last 10 minutes. Try again in 9 min.";
    expect(exportErrorMessage(429, "pdf", { error: limited })).toBe(limited);
    expect(exportErrorMessage(429, "pdf", null)).toBe("Too many PDF exports right now. Try again in a moment.");
  });

  it("labels the Share & Export buttons", () => {
    expect(MENU_FORMATS.map((f) => MENU_ITEM_LABEL[f])).toEqual(["Markdown (.md)", "Word (.docx)", "PDF (.pdf)"]);
  });

  describe("fetchExport", () => {
    const fake = (res: Response | Error) => vi.fn(async () => (res instanceof Error ? Promise.reject(res) : res)) as unknown as typeof fetch;

    it("names the file from the response", async () => {
      const f = fake(new Response("# Hi", { status: 200, headers: { "Content-Disposition": `attachment; filename="Memo.md"` } }));
      const out = await fetchExport("doc-1", "md", "x", f);
      expect(out.kind).toBe("file");
      expect(out.kind === "file" && out.filename).toBe("Memo.md");
      expect(f).toHaveBeenCalledWith("/api/documents/doc-1/export?format=md", { cache: "no-store" });
    });

    it("asks to print when the PDF renderer is unavailable, and only for PDF", async () => {
      const body = () => new Response(JSON.stringify({ error: "No renderer", fallback: "print" }), { status: 503 });
      expect(await fetchExport("d", "pdf", "x", fake(body()))).toEqual({ kind: "print" });
      expect(await fetchExport("d", "docx", "x", fake(body()))).toEqual({ kind: "error", message: "No renderer" });
    });

    it("turns failures into a sentence", async () => {
      expect(await fetchExport("d", "docx", "x", fake(new Response("", { status: 413 })))).toEqual({ kind: "error", message: "This document is too large to export as Word." });
      expect(await fetchExport("d", "md", "x", fake(new Error("offline")))).toEqual({ kind: "error", message: expect.stringMatching(/couldn't reach the server/) });
    });
  });
});
