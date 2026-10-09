import { describe, expect, it } from "vitest";
import { exportErrorMessage, exportUrl, filenameFromDisposition, isPrintFallback, MENU_FORMATS } from "./export-menu-model";

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
});
