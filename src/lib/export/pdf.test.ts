import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderSlots, findChrome, interceptDecision, LOCAL_CHROME_PATHS, PdfBusyError, renderPdf } from "./pdf";

describe("interceptDecision", () => {
  it("lets only inline data and the blank page load", () => {
    expect(interceptDecision("data:image/png;base64,AAAA")).toBe("continue");
    expect(interceptDecision("about:blank")).toBe("continue");
    for (const url of ["https://example.com/a.png", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "about:srcdoc", "blob:https://x/1", "chrome://settings", " data:x", "ws://x"]) {
      expect(interceptDecision(url)).toBe("abort");
    }
  });
});

describe("createRenderSlots", () => {
  afterEach(() => vi.useRealTimers());

  it("runs up to the cap at once, queues the next in order, and hands a released slot to the first in line", async () => {
    const slots = createRenderSlots(2, 2);
    const r1 = await slots.acquire(1000);
    await slots.acquire(1000);
    const order: string[] = [];
    const third = slots.acquire(1000).then((r) => (order.push("third"), r));
    const fourth = slots.acquire(1000).then((r) => (order.push("fourth"), r));
    expect([slots.active, slots.queued]).toEqual([2, 2]);
    r1();
    r1(); // a second call is a no-op
    (await third)();
    (await fourth)();
    expect(order).toEqual(["third", "fourth"]);
    expect([slots.active, slots.queued]).toEqual([1, 0]);
  });

  it("refuses at once when the queue is full, and after the wait when no slot frees", async () => {
    vi.useFakeTimers();
    const slots = createRenderSlots(1, 1);
    await slots.acquire(1000);
    const waiting = slots.acquire(1000);
    await expect(slots.acquire(1000)).rejects.toBeInstanceOf(PdfBusyError);
    vi.advanceTimersByTime(1000);
    await expect(waiting).rejects.toBeInstanceOf(PdfBusyError);
    expect([slots.active, slots.queued]).toEqual([1, 0]);
  });

  it("renderPdf waits for a slot and refuses with PdfBusyError rather than launching another Chrome", async () => {
    const slots = createRenderSlots(1, 0);
    await slots.acquire(1000);
    await expect(renderPdf("<p>x</p>", { slots, queueWaitMs: 50 })).rejects.toBeInstanceOf(PdfBusyError);
  });
});

describe("findChrome", () => {
  const MAC = LOCAL_CHROME_PATHS[0];
  it("honours CHROME_PATH when it exists, and doesn't fall back past a missing one", () => {
    expect(findChrome({ CHROME_PATH: "/opt/chrome" }, (p) => p === "/opt/chrome" || p === MAC)).toBe("/opt/chrome");
    expect(findChrome({ CHROME_PATH: "/opt/missing" }, (p) => p === MAC)).toBeNull();
  });

  it("uses the mac default, then the Linux paths, else none", () => {
    expect(findChrome({}, (p) => p === MAC)).toBe(MAC);
    expect(findChrome({}, (p) => p === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
    expect(findChrome({}, () => false)).toBeNull();
  });
});

// Manual check against a local Chrome: SASHA_PDF_SMOKE=1 npx vitest run src/lib/export/pdf.test.ts
describe.skipIf(process.env.SASHA_PDF_SMOKE !== "1")("renderPdf (local Chrome smoke)", () => {
  it("renders a PDF and loads nothing remote", async () => {
    const pdf = await renderPdf('<!doctype html><meta charset="utf-8"><h1>Hello</h1><img src="https://example.com/x.png"><p>World</p>', { timeoutMs: 30_000 });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 40_000);
});
