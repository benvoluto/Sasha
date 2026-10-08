import { describe, expect, it } from "vitest";
import { blobPathnameOf, matchesPresignedPath, safeFileName, SOURCE_BLOB_PATH_RE, sourceBlobPath, teamSlug } from "./blob-paths";

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("source blob paths", () => {
  it("hashes the team into a short stable slug", () => {
    expect(teamSlug("org:abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(teamSlug("org:abc")).toBe(teamSlug("org:abc"));
    expect(teamSlug("org:abc")).not.toBe(teamSlug("org:abd"));
  });

  it("builds paths that match the upload pattern", () => {
    const p = sourceBlobPath("org:abc", ID, "Q3 report.pdf");
    expect(p).toBe(`sources/${teamSlug("org:abc")}/${ID}/Q3 report.pdf`);
    expect(SOURCE_BLOB_PATH_RE.test(p)).toBe(true);
    expect(SOURCE_BLOB_PATH_RE.test(`upload-groups/x/files/0-a.pdf`)).toBe(false);
    expect(SOURCE_BLOB_PATH_RE.test(`sources/${teamSlug("t")}/${ID}/a/b.pdf`)).toBe(false);
  });

  it("makes file names safe", () => {
    const traversal = safeFileName("../../etc/passwd");
    expect(traversal).not.toContain("/");
    expect(traversal.startsWith(".")).toBe(false);
    expect(safeFileName("a/b\\c?.pdf")).toBe("a-b-c-.pdf");
    expect(safeFileName("   ")).toBe("file");
    const long = safeFileName("x".repeat(300) + ".docx");
    expect(long.length).toBe(120);
    expect(long.endsWith(".docx")).toBe(true);
  });

  it("accepts the store's random suffix and nothing else", () => {
    const presigned = `sources/${teamSlug("t")}/${ID}/report.pdf`;
    expect(matchesPresignedPath(presigned, presigned)).toBe(true);
    expect(matchesPresignedPath(`sources/${teamSlug("t")}/${ID}/report-Ab12Cd34Ef.pdf`, presigned)).toBe(true);
    expect(matchesPresignedPath(`sources/${teamSlug("t")}/${ID}/report-x/../y.pdf`, presigned)).toBe(false);
    expect(matchesPresignedPath(`sources/${teamSlug("t")}/${ID}/other-Ab12.pdf`, presigned)).toBe(false);
    expect(matchesPresignedPath(`sources/${teamSlug("u")}/${ID}/report-Ab12.pdf`, presigned)).toBe(false);
    expect(matchesPresignedPath(`sources/${teamSlug("t")}/${ID}/report-Ab12.exe`, presigned)).toBe(false);
  });

  it("reads the pathname from a blob URL", () => {
    expect(blobPathnameOf("https://x.public.blob.vercel-storage.com/sources/a/b/Q3%20report.pdf")).toBe("sources/a/b/Q3 report.pdf");
    expect(blobPathnameOf("nope")).toBeNull();
  });
});
