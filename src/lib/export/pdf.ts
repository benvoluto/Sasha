// PDF rendering (phase7-spec.md §4.4): the print HTML through headless Chrome.
// On Vercel, @sparticuz/chromium's bundled binary; locally, CHROME_PATH or the
// usual install paths. With no browser, PdfUnavailableError, which the export
// route turns into 503 {fallback:"print"} so the client prints the HTML itself.
//
// The page can't do anything but lay out: JavaScript is off, and every request
// other than data: and about:blank is aborted (interceptDecision). Both
// packages are imported dynamically so this module (and the route) load
// without them. Server-only.

import { existsSync } from "node:fs";
import { processMemory } from "@/lib/process-memory";
import { MAX_CONCURRENT_PDF_RENDERS, MAX_EXPORT_PDF_BYTES, MAX_QUEUED_PDF_RENDERS, PDF_QUEUE_WAIT_MS, PDF_RENDER_TIMEOUT_MS } from "./contract";

export class PdfUnavailableError extends Error {
  constructor(message = "No browser is available to render the PDF.") {
    super(message);
    this.name = "PdfUnavailableError";
  }
}

export class PdfTooLargeError extends Error {
  constructor() {
    super("The PDF is larger than the export limit.");
    this.name = "PdfTooLargeError";
  }
}

export class PdfTimeoutError extends Error {
  constructor() {
    super("The PDF took too long to render.");
    this.name = "PdfTimeoutError";
  }
}

export class PdfBusyError extends Error {
  constructor() {
    super("Too many PDFs are being rendered right now.");
    this.name = "PdfBusyError";
  }
}

export type RenderSlots = {
  /** Resolves with a release function once a slot is free; rejects with PdfBusyError when the queue is full or `waitMs` passes. */
  acquire(waitMs: number): Promise<() => void>;
  readonly active: number;
  readonly queued: number;
};

/** A counting semaphore with a bounded, first-come queue. */
export function createRenderSlots(max: number, maxQueued: number): RenderSlots {
  let active = 0;
  const waiting: Array<() => void> = [];
  const releaser = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // Hand the slot straight to the next in line, or free it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    };
  };
  return {
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
    acquire(waitMs) {
      if (active < max) {
        active++;
        return Promise.resolve(releaser());
      }
      if (waiting.length >= maxQueued || waitMs <= 0) return Promise.reject(new PdfBusyError());
      return new Promise((resolve, reject) => {
        const grant = () => {
          clearTimeout(timer);
          resolve(releaser());
        };
        const timer = setTimeout(() => {
          const i = waiting.indexOf(grant);
          if (i >= 0) waiting.splice(i, 1);
          reject(new PdfBusyError());
        }, waitMs);
        waiting.push(grant);
      });
    },
  };
}

/** This instance's render slots: a burst of exports can't start a Chrome per request and run it out of memory. */
const slots = processMemory("export.pdfSlots", () => createRenderSlots(MAX_CONCURRENT_PDF_RENDERS, MAX_QUEUED_PDF_RENDERS));

/** Pure: whether the render page may load `url`. Only inline data and the blank page; everything else is aborted. */
export function interceptDecision(url: string): "continue" | "abort" {
  return url.startsWith("data:") || url === "about:blank" ? "continue" : "abort";
}

export const LOCAL_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
] as const;

/** A local Chrome: CHROME_PATH when set (and present), else the first install path that exists, else null. */
export function findChrome(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const configured = env.CHROME_PATH?.trim();
  if (configured) return exists(configured) ? configured : null;
  return LOCAL_CHROME_PATHS.find((p) => exists(p)) ?? null;
}

/** The page footer: a fixed template (never document content) with page numbers. */
const FOOTER_TEMPLATE =
  '<div style="width:100%;font-size:8px;color:#777;text-align:center;font-family:system-ui,sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';

type LaunchOptions = { executablePath: string; args?: string[]; headless: boolean };

async function launchOptions(): Promise<LaunchOptions> {
  if (process.env.VERCEL) {
    try {
      const chromium = (await import("@sparticuz/chromium")).default;
      return { executablePath: await chromium.executablePath(), args: chromium.args, headless: true };
    } catch (err) {
      console.error("[export] chromium unavailable", err instanceof Error ? err.message : "unknown");
      throw new PdfUnavailableError();
    }
  }
  const executablePath = findChrome();
  if (!executablePath) throw new PdfUnavailableError();
  return { executablePath, args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"], headless: true };
}

/**
 * Renders `html` to PDF bytes, at most MAX_CONCURRENT_PDF_RENDERS at once per
 * instance; the wait for a slot counts against the deadline. Throws
 * PdfBusyError, PdfUnavailableError, PdfTimeoutError or PdfTooLargeError.
 */
export async function renderPdf(
  html: string,
  opts: { timeoutMs?: number; maxBytes?: number; queueWaitMs?: number; slots?: RenderSlots } = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? PDF_RENDER_TIMEOUT_MS;
  const started = Date.now();
  const release = await (opts.slots ?? slots).acquire(Math.min(opts.queueWaitMs ?? PDF_QUEUE_WAIT_MS, timeoutMs));
  let job: Promise<Buffer> | null = null;
  try {
    return await render(html, Math.max(1, timeoutMs - (Date.now() - started)), opts.maxBytes ?? MAX_EXPORT_PDF_BYTES, (j) => (job = j));
  } finally {
    // render() returns at its deadline even while Chrome is still starting;
    // the slot stays held until that Chrome has been closed, so the cap counts it.
    if (job) void (job as Promise<Buffer>).then(noop, noop).then(release);
    else release();
  }
}

const noop = () => undefined;

/** One render; `onJob` receives the inner work, which settles only once the browser it launched is closed. */
async function render(html: string, timeoutMs: number, maxBytes: number, onJob: (job: Promise<Buffer>) => void): Promise<Buffer> {
  const launch = await launchOptions();
  let puppeteer: typeof import("puppeteer-core");
  try {
    puppeteer = await import("puppeteer-core");
  } catch {
    throw new PdfUnavailableError();
  }

  const started = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new PdfTimeoutError());
    }, timeoutMs);
  });
  const close = async () => {
    const b = browser as { close: () => Promise<void> } | null;
    browser = null;
    if (b) await b.close().catch(() => undefined);
  };

  const work = async () => {
    try {
      browser = await puppeteer.launch({ ...launch, timeout: remaining() });
    } catch (err) {
      console.error("[export] browser launch failed", err instanceof Error ? err.message : "unknown");
      throw new PdfUnavailableError();
    }
    // The deadline passed while Chrome was starting: the finally below has already run.
    if (timedOut) {
      await close();
      throw new PdfTimeoutError();
    }
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (interceptDecision(req.url()) === "continue") void req.continue();
      else void req.abort("blockedbyclient");
    });
    await page.setContent(html, { waitUntil: "load", timeout: remaining() });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: FOOTER_TEMPLATE,
      timeout: remaining(),
    });
    if (pdf.byteLength > maxBytes) throw new PdfTooLargeError();
    return Buffer.from(pdf);
  };

  const job = work();
  job.catch(() => undefined); // after a timeout its rejection has no listener
  onJob(job);
  try {
    return await Promise.race([job, deadline]);
  } finally {
    clearTimeout(timer);
    await close();
  }
}
