import { describe, expect, it } from "vitest";
import { blobAccess } from "./blob-access";

describe("blobAccess", () => {
  it("defaults to private, which a private store requires", () => {
    expect(blobAccess({})).toBe("private");
    expect(blobAccess({ BLOB_ACCESS: "" })).toBe("private");
    expect(blobAccess({ BLOB_ACCESS: "something" })).toBe("private");
  });
  it("uses public only when the store is configured as public", () => {
    expect(blobAccess({ BLOB_ACCESS: "public" })).toBe("public");
    expect(blobAccess({ BLOB_ACCESS: " Public " })).toBe("public");
  });
});
