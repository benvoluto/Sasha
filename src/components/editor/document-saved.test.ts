import { describe, expect, it, vi } from "vitest";
import { notifyDocumentSaved, onDocumentSaved } from "./document-saved";

describe("document-saved", () => {
  it("tells each listener the saved id until it unsubscribes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onDocumentSaved(a);
    const offB = onDocumentSaved(b);
    notifyDocumentSaved("doc-1");
    expect(a).toHaveBeenCalledWith("doc-1");
    expect(b).toHaveBeenCalledWith("doc-1");
    offA();
    notifyDocumentSaved("doc-2");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenLastCalledWith("doc-2");
    offB();
  });

  it("keeps notifying the others when one listener throws", () => {
    const after = vi.fn();
    const offBad = onDocumentSaved(() => {
      throw new Error("boom");
    });
    const offAfter = onDocumentSaved(after);
    expect(() => notifyDocumentSaved("doc-3")).not.toThrow();
    expect(after).toHaveBeenCalledWith("doc-3");
    offBad();
    offAfter();
  });

  it("with no listeners does nothing", () => {
    expect(() => notifyDocumentSaved("doc-4")).not.toThrow();
  });
});
