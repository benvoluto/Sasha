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

/** Opens a blank document (/new) and waits until the editor takes input. */
export async function openNewDocument(page: Page) {
  await page.goto("/new");
  await expect(editorOf(page)).toBeVisible();
  await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
  await expect(saveStatus(page)).toContainText("Not saved yet");
  await settle(page);
}

/** The toolbar row's save status (save-status.tsx; its visible text reads "Saved 3 min ago", so check it with toContainText). */
export const saveStatus = (page: Page) => page.locator("[data-save-status]");

type TipTapNode = { type: string; attrs?: Record<string, unknown>; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: TipTapNode[] };
export const para = (...content: TipTapNode[]): TipTapNode => ({ type: "paragraph", content });
export const text = (t: string, marks?: TipTapNode["marks"]): TipTapNode => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
/** A heading; give it a `sectionId` (s_ and 8 characters, as the editor makes them) when the test needs the caret's section before any edit (the editor only fills missing ids on a change). */
export const heading = (t: string, level = 2, sectionId?: string): TipTapNode => ({ type: "heading", attrs: { level, ...(sectionId ? { sectionId } : {}) }, content: [text(t)] });

/** A passage citation mark (src/lib/citations/contract.ts); the source need not exist for the popover to open. */
export const citation = (sourceId = "00000000-0000-4000-8000-000000000001") => ({
  type: "citation",
  attrs: { kind: "passage", passageId: "S00000000.P1", sourceId, dataTableId: null, quote: "a quoted passage", verified: true },
});

/** Creates a document through the API and returns its id. */
export async function createDocument(request: APIRequestContext, body: { title: string; content?: TipTapNode[]; type_key?: string | null; notes?: string }): Promise<string> {
  const res = await request.post("/api/documents", {
    data: { title: body.title, type_key: body.type_key ?? null, content_json: { type: "doc", content: body.content ?? [para(text("Body text."))] }, ...(body.notes !== undefined ? { notes: body.notes } : {}) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).document.id as string;
}

/** PATCHes a document through the API (title, notes, archived, doc_folder_id, content_json…). */
export async function patchDocument(request: APIRequestContext, id: string, patch: Record<string, unknown>) {
  const res = await request.patch(`/api/documents/${id}`, { data: patch });
  expect(res.status(), await res.text()).toBe(200);
}

/** Creates a document folder through the API and returns its id. */
export async function createFolder(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/api/document-folders", { data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).folder.id as string;
}

/** Creates a standalone note through the API (redesign3-spec.md §7) and returns its id. */
export async function createNote(request: APIRequestContext, body: string): Promise<string> {
  const res = await request.post("/api/notes", { data: { body } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).note.id as string;
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

export type ModalTab = "Notes" | "Sources" | "Data" | "Suggestions" | "Workflows";
export type PanelName = "Agents" | "Outline";

/** The editor's right-hand button stack (redesign3-spec.md §13): the Sources pill, then Agents and Outline. */
export const panelGroup = (page: Page) => page.getByRole("group", { name: "Document panels" });

/** The Sources pill at the top of the stack; it opens the document modal on Sources. */
export const sourcesButton = (page: Page) => panelGroup(page).getByRole("button", { name: "Sources", exact: true });

/** The closed Agents or Outline button in the stack (it gives way to its card while the panel is open). */
export const panelButton = (page: Page, name: PanelName) => panelGroup(page).getByRole("button", { name, exact: true });

/** The open Agents or Outline card (its <aside>/region carries the panel's name). */
export const panelRegion = (page: Page, name: PanelName) => page.getByRole("complementary", { name, exact: true }).or(page.getByRole("region", { name, exact: true })).first();

/** Opens the Agents or Outline panel from its button; focus moves to the card's heading. Returns the card. */
export async function openPanel(page: Page, name: PanelName): Promise<Locator> {
  await panelButton(page, name).click();
  const card = panelRegion(page, name);
  await expect(card).toBeVisible();
  return card;
}

/** Opens the document modal from the Sources pill, then shows `tab` (Sources opens on its own tab). */
export async function openModal(page: Page, tab: ModalTab = "Notes"): Promise<Locator> {
  await sourcesButton(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const tabButton = dialog.getByRole("tab", { name: tab, exact: true });
  if (tab !== "Sources") await tabButton.click();
  await expect(tabButton).toHaveAttribute("aria-selected", "true");
  return dialog;
}

/** Opens the editor's Doc Gallery from the Outline panel's "See all document types" (opening the panel first) and waits for the dialog. */
export async function openGallery(page: Page): Promise<Locator> {
  if (!(await panelRegion(page, "Outline").isVisible())) await openPanel(page, "Outline");
  await panelRegion(page, "Outline").getByRole("button", { name: "See all document types" }).click();
  const dialog = page.getByRole("dialog", { name: "Doc Gallery" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Opens the Share & Export dialog from the editor header and waits for it. */
export async function openShareExport(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Share & Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share & Export" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The empty document's helper beside the dog (redesign2-spec.md §5). */
export const helperOf = (page: Page) => page.getByRole("region", { name: "Getting started" });

/** The overview's tablist (Documents / Notes). */
export const overviewTabs = (page: Page) => page.getByRole("tablist", { name: "Overview" });

/** Opens the documents overview (redesign3-spec.md §2) at `path` ("/", "/?tab=notes", "/?folder=<id>", "/?view=archived") and waits for it. */
export async function openOverview(page: Page, path = "/") {
  await page.goto(path);
  await expect(overviewTabs(page)).toBeVisible();
  await settle(page);
}

/** Escapes a string for a RegExp. */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The overview card that shows `text` (its title, or its subtitle for an
 * untitled one): the innermost element in <main> holding that text and a
 * card's "Actions for …" menu button.
 */
export const overviewCard = (page: Page, text: string) =>
  page.locator("#main-content *").filter({ hasText: text }).filter({ has: page.getByRole("button", { name: /^Actions for (?!folder )/ }) }).last();

/** A card's "⋯" menu button. */
export const cardMenuButton = (page: Page, title: string) => page.getByRole("button", { name: `Actions for ${title}`, exact: true });

/** A folder tile: a button named "<name>, <n> documents". */
export const folderTile = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${escapeRe(name)}, \\d+ documents?$`) });

/** Opens the user menu ("Account menu") and returns the menu. */
export async function openUserMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu");
  // A menu that is still closing (after picking an item) would swallow the click.
  await expect(menu).toHaveCount(0);
  await expect(async () => {
    if (!(await menu.isVisible())) await page.getByRole("button", { name: "Account menu" }).click();
    await expect(menu).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return menu;
}

/** Presses Tab until `target` has focus (at most `max` presses), as a keyboard user would. */
export async function tabTo(page: Page, target: Locator, { max = 60, back = false } = {}) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el: Element) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  await expect(target, `reached by ${back ? "Shift+Tab" : "Tab"} within ${max} presses`).toBeFocused();
}

/** True when focus is on `target` or inside it. */
export const focusWithin = (target: Locator) => target.evaluate((el: Element) => el === document.activeElement || el.contains(document.activeElement));

/** Tabs `presses` times forwards, then backwards, checking that focus never leaves `dialog` (a focus trap). */
export async function expectFocusTrapped(page: Page, dialog: Locator, presses = 25) {
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(key);
      expect(await focusWithin(dialog), `focus stays in the dialog after ${i + 1} × ${key}`).toBe(true);
    }
  }
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
  // The scheme under test is the one on the page (next-themes follows the emulated colour scheme).
  if (testInfo.project.name === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
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
