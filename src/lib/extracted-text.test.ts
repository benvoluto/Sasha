import { describe, expect, it } from "vitest";
import { checkExtraction, documentSections, emptyExtractionMessage, hasReadableText, LINKED_PDF_ADVICE, readableText, UPLOAD_ADVICE } from "./extracted-text";
import { reconcileGeminiStatus } from "./processing-status";

// What the parallel extractor stored for the Jordan S. packet: the header it adds itself, and nothing else.
const HEADER_ONLY = "=== Document: Quarterly_Report.pdf ===\n";
type Result = { extractedContent: string; status: "success" | "error" | "partial"; fileCount: number; error?: string };
const result = (r: Result) => r;
const READ = "=== Document: a.pdf ===\n--- Page 1 ---\nPROJECT: Riverside expansion. Phase 2, site B.";

describe("readable text", () => {
  it("ignores the app's own document and page markers", () => {
    expect(readableText(HEADER_ONLY)).toBe("");
    expect(hasReadableText(HEADER_ONLY)).toBe(false);
    expect(hasReadableText("=== Document: a.pdf ===\n--- Page 1 ---\n--- Page 2 ---\n\n=== Additional documents (added x) ===\n")).toBe(false);
    expect(hasReadableText(READ)).toBe(true);
    expect(hasReadableText(undefined)).toBe(false);
  });

  it("finds which documents came back empty", () => {
    expect(documentSections(`${READ}\n\n${HEADER_ONLY}`)).toEqual([
      { name: "a.pdf", readable: true },
      { name: "Quarterly_Report.pdf", readable: false },
    ]);
  });
});

describe("checkExtraction", () => {
  const files = [{ name: "Quarterly_Report.pdf" }];

  it("turns a 'success' with no text into an error naming the file", () => {
    const r = checkExtraction(result({ extractedContent: HEADER_ONLY, status: "success", fileCount: 1 }), files);
    expect(r.status).toBe("error");
    expect(r.fileCount).toBe(0);
    expect(r.error).toContain('No text could be read from "Quarterly_Report.pdf"');
  });

  it("marks a read with one empty document as partial", () => {
    const r = checkExtraction(result({ extractedContent: `${READ}\n\n${HEADER_ONLY}`, status: "success", fileCount: 2 }), [{ name: "a.pdf" }, ...files]);
    expect(r.status).toBe("partial");
    expect(r.error).toContain("Quarterly_Report.pdf");
    expect(r.error).not.toContain("a.pdf\"");
  });

  it("leaves good reads and existing errors alone", () => {
    const ok = { extractedContent: READ, status: "success" as const, fileCount: 1 };
    expect(checkExtraction(ok, [{ name: "a.pdf" }])).toBe(ok);
    const err = { extractedContent: "", status: "error" as const, fileCount: 0, error: "Gemini API not configured" };
    expect(checkExtraction(err, files)).toBe(err);
  });
});

describe("emptyExtractionMessage", () => {
  it("advises uploading again by default", () => {
    expect(emptyExtractionMessage(["a.pdf"], "MAX_TOKENS")).toBe(`No text could be read from "a.pdf" (the AI service ran out of room for its reply). ${UPLOAD_ADVICE}`);
  });

  it("takes a hint in place of the default advice", () => {
    const m = emptyExtractionMessage(["r.pdf"], undefined, LINKED_PDF_ADVICE);
    expect(m).toBe('No text could be read from "r.pdf". Read it again, or download the PDF and upload it as a file.');
    expect(m).not.toContain("Try uploading");
  });

  it("passes the hint through checkExtraction", () => {
    const r = checkExtraction(result({ extractedContent: HEADER_ONLY, status: "success", fileCount: 1 }), [{ name: "r.pdf" }], LINKED_PDF_ADVICE);
    expect(r.error).toContain(LINKED_PDF_ADVICE);
    const partial = checkExtraction(result({ extractedContent: `${READ}\n\n${HEADER_ONLY}`, status: "success", fileCount: 2 }), [{ name: "a.pdf" }], LINKED_PDF_ADVICE);
    expect(partial.error).toContain(LINKED_PDF_ADVICE);
  });
});

describe("reconcileGeminiStatus", () => {
  it("reports a stored header-only 'completed' case as a failed read", () => {
    const r = reconcileGeminiStatus<{ geminiProcessing: { status: string; extractedContent: string; error?: string } }>({ geminiProcessing: { status: "completed", extractedContent: HEADER_ONLY } });
    expect(r.geminiProcessing).toMatchObject({ status: "error" });
    expect(r.geminiProcessing!.error).toContain("Quarterly_Report.pdf");
  });

  it("leaves a case whose documents were all removed as completed", () => {
    const meta = { geminiProcessing: { status: "completed", extractedContent: "" } };
    expect(reconcileGeminiStatus(meta)).toBe(meta);
  });

  it("does not promote a header-only 'processing' case to completed", () => {
    const meta = { geminiProcessing: { status: "processing", extractedContent: HEADER_ONLY } };
    expect(reconcileGeminiStatus(meta)).toBe(meta);
  });
});
