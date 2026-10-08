import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));

import { uploadProblems } from "./upload";

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
