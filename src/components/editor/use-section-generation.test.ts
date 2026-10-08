import { describe, expect, it } from "vitest";
import { applyDecision, busyAnnouncement, generationError, preflightError } from "./use-section-generation";

describe("applyDecision", () => {
  it("applies a draft when the body is still empty", () => {
    expect(applyDecision("", { bodyText: "" })).toBe("apply");
    expect(applyDecision("", { bodyText: "  \n" })).toBe("apply");
  });

  it("applies a rewrite when the body reads as it did", () => {
    expect(applyDecision("Some text.", { bodyText: "Some text.\n" })).toBe("apply");
  });

  it("asks first when the section changed while Claude was writing", () => {
    expect(applyDecision("", { bodyText: "I started writing" })).toBe("changed");
    expect(applyDecision("Some text.", { bodyText: "Some other text." })).toBe("changed");
  });

  it("gives up when the section was deleted", () => {
    expect(applyDecision("Some text.", null)).toBe("deleted");
  });
});

describe("generationError", () => {
  it("prefers the server's message", () => {
    expect(generationError(409, { error: "This section is fixed text; edit it directly." })).toBe("This section is fixed text; edit it directly.");
  });
  it("explains common statuses without one", () => {
    expect(generationError(503, {})).toBe("Claude is not configured.");
    expect(generationError(404, {})).toMatch(/isn't available/);
    expect(generationError(500, {})).toMatch(/500/);
  });
});

describe("preflightError", () => {
  const section = { heading: "Background", bodyText: "Some text." };
  it("lets a run start when the section is ready", () => {
    expect(preflightError(section, "draft", false)).toBeNull();
    expect(preflightError(section, "rewrite", false)).toBeNull();
  });
  it("explains why a run can't start", () => {
    expect(preflightError(section, "draft", true)).toMatch(/already writing/);
    expect(preflightError(null, "draft", false)).toMatch(/no longer exists/);
    expect(preflightError({ heading: "  ", bodyText: "" }, "draft", false)).toMatch(/heading first/);
    expect(preflightError({ heading: "Background", bodyText: " \n" }, "rewrite", false)).toMatch(/Nothing to rewrite/);
  });
});

describe("busyAnnouncement", () => {
  it("names the section being written, or counts them", () => {
    expect(busyAnnouncement([])).toBe("");
    expect(busyAnnouncement(["Background"])).toBe("Claude is writing “Background”.");
    expect(busyAnnouncement([""])).toBe("Claude is writing “Untitled section”.");
    expect(busyAnnouncement(["A", "B"])).toBe("Claude is writing 2 sections.");
  });
});
