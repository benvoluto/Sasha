import { describe, expect, it } from "vitest";
import { deriveCaseState, STATE_LABEL } from "./case-state";
import type { UploadGroup } from "./atoms";

const now = () => new Date().toISOString();
const group = (over: Partial<UploadGroup> = {}) =>
  ({ id: "g", uploadDate: now(), files: [], totalSize: 0, ...over }) as UploadGroup;

describe("deriveCaseState", () => {
  it("is uploading before any extraction record exists", () => {
    expect(deriveCaseState(group()).key).toBe("uploading");
  });

  it("is extracting while the files are being read", () => {
    const s = deriveCaseState(group({ geminiProcessing: { status: "processing", processedAt: now() } }));
    expect(s.key).toBe("extracting");
    expect(s.label).toBe(STATE_LABEL.extracting);
  });

  it("is an error once extraction has stalled", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const s = deriveCaseState(group({ uploadDate: old, geminiProcessing: { status: "processing", processedAt: old } }));
    expect(s.key).toBe("error");
    expect(s.detail).toMatch(/stalled/);
  });

  it("is an error when extraction failed or was partial", () => {
    expect(deriveCaseState(group({ geminiProcessing: { status: "error", error: "boom" } }))).toMatchObject({ key: "error", detail: "boom" });
    expect(deriveCaseState(group({ geminiProcessing: { status: "partial" } })).key).toBe("error");
  });

  it("is ready once extraction completed", () => {
    expect(deriveCaseState(group({ geminiProcessing: { status: "completed", processedAt: now() } })).key).toBe("ready");
  });
});
