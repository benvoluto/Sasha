import { describe, expect, it, vi } from "vitest";
import { classifyGeminiError, waitForActive, waitForActiveFiles, withGeminiRetry } from "./gemini-files";

/** Minimal stand-in for the SDK's files client: returns the given states in order. */
function filesReturning(states: Array<string | Error>) {
  let i = 0;
  return {
    files: {
      get: vi.fn(async () => {
        const s = states[Math.min(i++, states.length - 1)];
        if (s instanceof Error) throw s;
        return { state: s };
      }),
    },
  } as unknown as Parameters<typeof waitForActive>[0];
}

const fast = { timeoutMs: 200, pollMs: 1 };

describe("waitForActive", () => {
  it("resolves true once the file reports ACTIVE", async () => {
    expect(await waitForActive(filesReturning(["PROCESSING", "PROCESSING", "ACTIVE"]), "files/x", fast)).toBe(true);
  });

  it("gives up immediately on FAILED rather than burning the timeout", async () => {
    const ai = filesReturning(["FAILED"]);
    expect(await waitForActive(ai, "files/x", fast)).toBe(false);
    expect((ai as unknown as { files: { get: { mock: { calls: unknown[] } } } }).files.get.mock.calls).toHaveLength(1);
  });

  it("returns false when the file never becomes ready", async () => {
    expect(await waitForActive(filesReturning(["PROCESSING"]), "files/x", fast)).toBe(false);
  });

  it("keeps polling through a transient get() error", async () => {
    expect(await waitForActive(filesReturning([new Error("network blip"), "ACTIVE"]), "files/x", fast)).toBe(true);
  });
});

describe("waitForActiveFiles", () => {
  it("partitions rather than failing the batch for one slow file", async () => {
    // A single client whose response depends on the file name.
    const ai = {
      files: {
        get: vi.fn(async ({ name }: { name: string }) => ({ state: name === "slow" ? "PROCESSING" : "ACTIVE" })),
      },
    } as unknown as Parameters<typeof waitForActiveFiles>[0];
    const files = [
      { name: "ok", uri: "u1", mimeType: "application/pdf" },
      { name: "slow", uri: "u2", mimeType: "application/pdf" },
    ];
    const { ready, notReady } = await waitForActiveFiles(ai, files, fast);
    expect(ready.map((f) => f.name)).toEqual(["ok"]);
    expect(notReady.map((f) => f.name)).toEqual(["slow"]);
  });
});

describe("classifyGeminiError", () => {
  // The failure the user actually hit: a PDF still in PROCESSING rejects the
  // whole generateContent call.
  it("recognizes a not-yet-ACTIVE file as transient", () => {
    const c = classifyGeminiError(new Error("400 The File files/abc is not in an ACTIVE state and usage is not allowed."));
    expect(c.transient).toBe(true);
    expect(c.message).toMatch(/still being prepared/i);
  });

  it("recognizes rate limiting as transient", () => {
    expect(classifyGeminiError(new Error("429 RESOURCE_EXHAUSTED")).transient).toBe(true);
  });

  it("recognizes an overloaded model as transient", () => {
    expect(classifyGeminiError(new Error("503 Service Unavailable: model overloaded")).transient).toBe(true);
  });

  it("treats a bad API key as permanent", () => {
    const c = classifyGeminiError(new Error("403 PERMISSION_DENIED: API key not valid"));
    expect(c.transient).toBe(false);
    expect(c.message).toMatch(/admin/i);
  });

  it("carries the underlying cause into unknown failures instead of swallowing it", () => {
    expect(classifyGeminiError(new Error("something nobody anticipated")).message).toContain("something nobody anticipated");
  });

  it("trims multi-line errors to one readable line", () => {
    expect(classifyGeminiError(new Error("boom\n  at foo\n  at bar")).message).not.toContain("at foo");
  });

  it("handles non-Error throws", () => {
    expect(classifyGeminiError("plain string failure").message).toContain("plain string failure");
  });
});

describe("withGeminiRetry", () => {
  it("retries a transient failure and succeeds", async () => {
    let calls = 0;
    const result = await withGeminiRetry(
      async () => {
        if (++calls < 3) throw new Error("503 overloaded");
        return "ok";
      },
      { backoffMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    await expect(
      withGeminiRetry(
        async () => {
          calls++;
          throw new Error("403 PERMISSION_DENIED");
        },
        { backoffMs: 1 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget and rethrows the real error", async () => {
    await expect(
      withGeminiRetry(async () => { throw new Error("429 rate limit"); }, { attempts: 2, backoffMs: 1 }),
    ).rejects.toThrow(/429/);
  });
});
