import { describe, expect, it } from "vitest";
import { savedAgo } from "./save-status-model";

const at = (iso: string) => new Date(iso).getTime();
const SAVED = "2026-10-03T12:00:00";

describe("savedAgo", () => {
  it("reads just now for the first minute", () => {
    expect(savedAgo(SAVED, at(SAVED))).toBe("Saved just now");
    expect(savedAgo(SAVED, at(SAVED) + 59_999)).toBe("Saved just now");
  });

  it("counts whole minutes under an hour", () => {
    expect(savedAgo(SAVED, at(SAVED) + 60_000)).toBe("Saved 1 min ago");
    expect(savedAgo(SAVED, at(SAVED) + 3 * 60_000 + 30_000)).toBe("Saved 3 min ago");
    expect(savedAgo(SAVED, at(SAVED) + 59 * 60_000 + 59_000)).toBe("Saved 59 min ago");
  });

  it("counts whole hours under a day", () => {
    expect(savedAgo(SAVED, at(SAVED) + 60 * 60_000)).toBe("Saved 1 h ago");
    expect(savedAgo(SAVED, at(SAVED) + 23 * 3_600_000 + 59 * 60_000)).toBe("Saved 23 h ago");
  });

  it("shows the date after a day", () => {
    expect(savedAgo(SAVED, at(SAVED) + 24 * 3_600_000)).toBe("Saved Oct 3");
    expect(savedAgo("2026-01-15T08:00:00", at("2026-03-01T08:00:00"))).toBe("Saved Jan 15");
  });

  it("treats a future or unreadable time as just now", () => {
    expect(savedAgo(SAVED, at(SAVED) - 5 * 60_000)).toBe("Saved just now");
    expect(savedAgo("not a date", at(SAVED))).toBe("Saved just now");
  });
});
