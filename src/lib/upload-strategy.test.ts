import { describe, expect, it } from "vitest";
import { DIRECT_UPLOAD_CONFIG, resolveUploadType } from "./upload-strategy";

describe("resolveUploadType", () => {
  it("accepts the supported types", () => {
    expect(resolveUploadType("a.pdf", "application/pdf")).toBe("application/pdf");
    expect(resolveUploadType("a.PNG", "image/png")).toBe("image/png");
    expect(resolveUploadType("a.jpg", "image/jpeg")).toBe("image/jpeg");
    expect(resolveUploadType("a.webp", "image/webp")).toBe("image/webp");
    expect(resolveUploadType("a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("uses the extension when the browser's type is vague", () => {
    expect(resolveUploadType("notes.md", "")).toBe("text/markdown");
    expect(resolveUploadType("data.csv", "application/vnd.ms-excel")).toBe("text/csv");
    expect(resolveUploadType("a.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(resolveUploadType("notes.md", "text/plain")).toBe("text/markdown");
  });

  it("refuses unsupported or mismatched types", () => {
    expect(resolveUploadType("a.exe", "application/x-msdownload")).toBeNull();
    expect(resolveUploadType("a.html", "text/html")).toBeNull();
    expect(resolveUploadType("a.svg", "image/svg+xml")).toBeNull();
    expect(resolveUploadType("a.exe", "")).toBeNull();
    expect(resolveUploadType("a.pdf", "image/png")).toBeNull();
  });

  it("builds an accept map for the dropzone", () => {
    expect(DIRECT_UPLOAD_CONFIG.accept["image/jpeg"]).toEqual([".jpg", ".jpeg"]);
    expect(DIRECT_UPLOAD_CONFIG.allowedTypes).toContain("text/csv");
  });
});
