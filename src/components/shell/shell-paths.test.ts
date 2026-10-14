import { describe, expect, it } from "vitest";
import { showsDog } from "./shell-paths";

describe("showsDog", () => {
  it("shows Sasha on the overview, documents and Activity", () => {
    for (const p of ["/", "/new", "/d/abc", "/activity"]) expect(showsDog(p)).toBe(true);
  });
  it("leaves her out elsewhere", () => {
    for (const p of ["/library", "/catalog", "/usage", "/workflows", "/sign-in", "/d", "/newx", "/activityx", "", null, undefined]) expect(showsDog(p)).toBe(false);
  });
});
