import { describe, expect, it } from "vitest";
import { initialsFor } from "./user-menu-model";

describe("initialsFor", () => {
  it("takes the first and last name's initials", () => {
    expect(initialsFor("Ann Lee")).toBe("AL");
    expect(initialsFor("  mary jane   watson ")).toBe("MW");
    expect(initialsFor("Dev user")).toBe("DU");
    expect(initialsFor("Cher")).toBe("C");
  });
  it("falls back to the email's first letter", () => {
    expect(initialsFor("bo@example.com", "bo@example.com")).toBe("B");
    expect(initialsFor("", "zed@example.com")).toBe("Z");
    expect(initialsFor("", "")).toBe("?");
  });
});
