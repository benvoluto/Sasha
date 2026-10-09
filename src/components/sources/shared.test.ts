import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAfterMs } from "@/lib/limits/client";
import { api, ApiError } from "./shared";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The suggestions pane waits quietly on a background 429; it reads the status,
// body and Retry-After off what api() throws.
describe("api", () => {
  it("throws an ApiError with the server's sentence, status, body and Retry-After", async () => {
    const body = { error: "You've used 30 suggestion runs this hour. Try again in 5 minutes.", code: "rate_limited", retry_after_seconds: 300 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 429, headers: { "Retry-After": "300" } })));
    const error = await api("/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    const e = error as ApiError;
    expect(e.message).toBe(body.error);
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe("300");
    expect(retryAfterMs(e.status, e.body, e.retryAfter)).toBe(300_000);
  });

  it("falls back to a generic message when the body has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 500 })));
    const e = (await api("/x").catch((err: unknown) => err)) as ApiError;
    expect(e.message).toBe("Request failed (500).");
    expect(e.retryAfter).toBeNull();
    expect(retryAfterMs(e.status, e.body, e.retryAfter)).toBeNull();
  });

  it("returns the parsed body on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })));
    await expect(api<{ ok: number }>("/x")).resolves.toEqual({ ok: 1 });
  });
});
