// Shared helpers for the Playwright specs (playwright.config.ts has how to run
// them). The server runs with the dev auth bypass and the e2e stubs, with the
// in-memory stores: every test starts from whatever earlier tests left, so a
// test creates what it needs and finds it by a unique name.

import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";

export { expect };
export type { Locator, Page };

/** A unique, readable marker for this run, so a test finds its own rows in a shared store. */
export const uid = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const test = base.extend<{ consoleErrors: string[] }>({
  // Uncaught page errors fail the test that caused them (a crashed pane would
  // otherwise pass an axe scan with less on the page).
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await use(errors);
      expect(errors, "uncaught errors in the page").toEqual([]);
    },
    { auto: true },
  ],
});

/** The editor's ProseMirror surface. */
export const editorOf = (page: Page) => page.locator('.ProseMirror[aria-label="Document"]');

/** Opens a blank document and waits until the editor takes input. */
export async function openNewDocument(page: Page) {
  await page.goto("/");
  await expect(editorOf(page)).toBeVisible();
  await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
  await expect(saveStatus(page)).toHaveText("Not saved yet");
  await settle(page);
}

/** The header's save status line. */
export const saveStatus = (page: Page) => page.locator("header [role=status]:not(.sr-only)").first();

type TipTapNode = { type: string; attrs?: Record<string, unknown>; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: TipTapNode[] };
export const para = (...content: TipTapNode[]): TipTapNode => ({ type: "paragraph", content });
export const text = (t: string, marks?: TipTapNode["marks"]): TipTapNode => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
export const heading = (t: string, level = 2): TipTapNode => ({ type: "heading", attrs: { level }, content: [text(t)] });

/** A passage citation mark (src/lib/citations/contract.ts); the source need not exist for the popover to open. */
export const citation = (sourceId = "00000000-0000-4000-8000-000000000001") => ({
  type: "citation",
  attrs: { kind: "passage", passageId: "S00000000.P1", sourceId, dataTableId: null, quote: "a quoted passage", verified: true },
});

/** Creates a document through the API and returns its id. */
export async function createDocument(request: APIRequestContext, body: { title: string; content?: TipTapNode[]; type_key?: string | null }): Promise<string> {
  const res = await request.post("/api/documents", { data: { title: body.title, type_key: body.type_key ?? null, content_json: { type: "doc", content: body.content ?? [para(text("Body text."))] } } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).document.id as string;
}

/** Opens a saved document and waits for its body. */
export async function openDocument(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(editorOf(page)).toBeVisible();
  await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
  await settle(page);
}

/**
 * Waits for the page's first requests to finish (a cold route compiles while
 * the page settles). Focus stays where the page put it: the App Router
 * focuses a segment's first DOM node, which on the editor page is a plain
 * <div> wrapping <main id="main-content">, so it never takes the editor's caret.
 */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}

/** Opens the document modal from the Notes control and waits for the dialog. */
export async function openModal(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The element that has focus matches :focus-visible (the keyboard focus ring would show). */
export async function expectFocusVisible(page: Page, expected?: Locator) {
  if (expected) await expect(expected).toBeFocused();
  const visible = await page.evaluate(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return !!el && el !== document.body && el.matches(":focus-visible");
  });
  expect(visible, "the focused element shows a keyboard focus indicator").toBe(true);
}

/**
 * Sends the browser's @vercel/blob/client uploads to the e2e store. The client
 * PUTs the file to https://vercel.com/api/blob/?pathname=… (getApiUrl in
 * @vercel/blob; no VERCEL_BLOB_API_URL in the browser) over XHR; this forwards
 * the bytes to /api/e2e/blob, which answers with the Blob API's JSON. The token
 * request to /api/upload/direct runs unchanged: client tokens are signed
 * locally from the fake BLOB_READ_WRITE_TOKEN.
 *
 * Chromium doesn't hand an intercepted XHR's File body to Playwright
 * (postDataBuffer() is empty), so the test registers each file it uploads and
 * the bytes are taken from there, matched by the file name ending the pathname.
 */
export async function routeBlobUploads(page: Page) {
  const files = new Map<string, Buffer>();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "PUT, POST, OPTIONS", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
  await page.route(/^https:\/\/vercel\.com\/api\/blob\//, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const pathname = new URL(req.url()).searchParams.get("pathname");
    const body = req.postDataBuffer() ?? (pathname ? files.get(pathname.split("/").pop() ?? "") : undefined);
    if (req.method() !== "PUT" || !pathname || !body) {
      return route.fulfill({ status: 400, headers: cors, json: { error: { code: "e2e", message: `No e2e upload registered for ${pathname ?? "this request"}.` } } });
    }
    const res = await page.request.put(`/api/e2e/blob?pathname=${encodeURIComponent(pathname)}`, {
      data: body,
      headers: { "x-content-type": (await req.headerValue("x-content-type")) ?? "application/octet-stream" },
    });
    await route.fulfill({ status: res.status(), headers: { ...cors, "content-type": "application/json" }, body: await res.body() });
  });
  return {
    /** The bytes of a file the test is about to upload, under its name (keep it free of characters safeFileName changes). */
    register: (name: string, bytes: Buffer) => void files.set(name, bytes),
  };
}

/** WCAG 2.0/2.1 A and AA; serious and critical violations fail. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const FAILING = new Set(["serious", "critical"]);

/**
 * Runs axe on the page (or `include`), attaches the full result, prints each
 * violation (rule, impact, targets, help URL) and fails on serious/critical ones.
 */
export async function expectNoA11yViolations(page: Page, testInfo: TestInfo, screen: string, include?: string) {
  // Let transitions and late renders settle so axe doesn't read half-faded colours.
  await page.waitForTimeout(400);
  // @axe-core/playwright types its page against the hoisted playwright-core
  // (a newer minor than @playwright/test's own); the runtime API is the same.
  let builder = new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"] }).withTags(AXE_TAGS);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const scheme = testInfo.project.name;
  await testInfo.attach(`axe-${screen}-${scheme}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  const lines = results.violations.map((v) => {
    const targets = v.nodes
      .slice(0, 8)
      .map((n) => `      ${n.target.join(" ")}\n        ${n.html.replace(/\s+/g, " ").slice(0, 160)}${n.failureSummary ? `\n        ${n.failureSummary.split("\n").slice(1, 2).join("").trim()}` : ""}`)
      .join("\n");
    return `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})\n    ${v.helpUrl}\n${targets}`;
  });
  if (lines.length) console.log(`\naxe ${screen} (${scheme}) at ${page.url()}:\n${lines.join("\n")}`);
  const failing = results.violations.filter((v) => FAILING.has(v.impact ?? ""));
  expect(failing.map((v) => `${v.id} [${v.impact}] ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `serious/critical axe violations on ${screen} (${scheme})`).toEqual([]);
}
