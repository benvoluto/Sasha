// The documents overview (redesign3-spec.md §2, §4, §8, §9): cards, folders,
// Select mode, the archive, search, the Doc Gallery, New, the user menu and
// the Activity page. The stores are shared by every test, so each test makes
// its own documents and folders through the API and finds them by a uid() name.

import {
  cardMenuButton,
  createDocument,
  createFolder,
  editorOf,
  expect,
  folderTile,
  heading,
  openDocument,
  openOverview,
  openUserMenu,
  overviewCard,
  overviewTabs,
  para,
  patchDocument,
  saveStatus,
  settle,
  test,
  text,
  uid,
  type Page,
} from "./fixtures";

/** General report's sections (src/catalog/types/general-report.json). */
const GENERAL_REPORT = ["Introduction", "Background", "Findings", "Discussion", "Recommendations"];

const main = (page: Page) => page.locator("#main-content");

/** Picks `item` from a card's "⋯" menu. */
async function cardAction(page: Page, title: string, item: string) {
  const button = cardMenuButton(page, title);
  await overviewCard(page, title).hover();
  await button.click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.describe("cards", () => {
  test("show the type's icon, the first line under the title, and “Untitled” when the title is blank", async ({ page, request }) => {
    const typed = uid("Card typed");
    const firstLine = uid("Opening line");
    await createDocument(request, { title: typed, type_key: "proposal", content: [para(text(firstLine)), para(text("A second paragraph."))] });
    const untitledBody = uid("Untitled body");
    await createDocument(request, { title: "", content: [para(text(untitledBody))] });

    await openOverview(page);
    const card = overviewCard(page, typed);
    await expect(card).toBeVisible();
    await expect(card.locator("svg").first()).toBeVisible();
    await expect(card).toContainText(firstLine);
    await expect(card).not.toContainText("A second paragraph.");
    // The whole card opens the document.
    await expect(card.getByRole("link").first()).toHaveAttribute("href", /^\/d\/[0-9a-f-]{36}$/);

    const untitled = overviewCard(page, untitledBody);
    await expect(untitled).toContainText("Untitled");
    await expect(untitled.locator("svg").first()).toBeVisible();
    await expect(untitled.getByRole("button", { name: "Actions for Untitled" })).toHaveCount(1);
  });

  test("Rename from the card's menu saves the new title", async ({ page, request }) => {
    const title = uid("Rename me");
    const id = await createDocument(request, { title });
    await openOverview(page);
    await cardAction(page, title, "Rename");
    const renamed = uid("Renamed");
    const field = main(page).getByRole("textbox").filter({ visible: true }).first();
    await expect(field).toBeFocused();
    await field.fill(renamed);
    await page.keyboard.press("Enter");
    await expect(overviewCard(page, renamed)).toBeVisible();
    await expect.poll(async () => (await (await request.get(`/api/documents/${id}`)).json()).document.title).toBe(renamed);
  });
});

test.describe("folders", () => {
  test("create, rename and delete a folder from its tiles", async ({ page }) => {
    await openOverview(page);
    const name = uid("Folder new");
    await main(page).getByRole("button", { name: "New folder" }).click();
    const field = main(page).getByRole("textbox").filter({ visible: true }).first();
    await expect(field).toBeFocused();
    await field.fill(name);
    await page.keyboard.press("Enter");
    await expect(folderTile(page, name)).toBeVisible();
    await expect(folderTile(page, name)).toHaveAccessibleName(`${name}, 0 documents`);

    const renamed = uid("Folder renamed");
    await folderTile(page, name).hover();
    await page.getByRole("button", { name: `Actions for folder ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const rename = main(page).getByRole("textbox").filter({ visible: true }).first();
    await expect(rename).toBeFocused();
    await rename.fill(renamed);
    await page.keyboard.press("Enter");
    await expect(folderTile(page, renamed)).toBeVisible();
    await expect(folderTile(page, name)).toHaveCount(0);

    await folderTile(page, renamed).hover();
    await page.getByRole("button", { name: `Actions for folder ${renamed}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(main(page).getByText(`Delete folder “${renamed}”? Its documents move to the top level.`)).toBeVisible();
    await main(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(folderTile(page, renamed)).toHaveCount(0);
  });

  test("a folder opens in place and “All documents” comes back", async ({ page, request }) => {
    const name = uid("Folder open");
    const folderId = await createFolder(request, name);
    const inside = uid("Inside folder");
    const docId = await createDocument(request, { title: inside });
    await patchDocument(request, docId, { doc_folder_id: folderId });
    const outside = uid("Outside folder");
    await createDocument(request, { title: outside });

    await openOverview(page);
    // Filed documents leave the top level.
    await expect(overviewCard(page, outside)).toBeVisible();
    await expect(overviewCard(page, inside)).toHaveCount(0);
    await expect(folderTile(page, name)).toHaveAccessibleName(/, 1 documents?$/);

    await folderTile(page, name).click();
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${folderId}`));
    // The folder's name heads the view (one visible heading; the spec's sr-only h1 plus h2 or a single h1 both pass).
    await expect(main(page).getByRole("heading", { name, exact: true }).first()).toBeVisible();
    await expect(overviewCard(page, inside)).toBeVisible();
    await expect(overviewCard(page, outside)).toHaveCount(0);

    await main(page).getByRole("button", { name: "All documents" }).or(main(page).getByRole("link", { name: "All documents" })).first().click();
    await expect(page).not.toHaveURL(/folder=/);
    await expect(overviewCard(page, outside)).toBeVisible();
    await expect(folderTile(page, name)).toBeVisible();

    // The address keeps the folder (router.replace), so a reload opens it again.
    await folderTile(page, name).click();
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${folderId}`));
    await page.reload();
    await expect(overviewCard(page, inside)).toBeVisible();
    await expect(overviewCard(page, outside)).toHaveCount(0);
  });

  test("dragging a card onto a folder files it: the card leaves the grid and the count goes up", async ({ page, request }) => {
    const name = uid("Drop folder");
    await createFolder(request, name);
    const title = uid("Drag me");
    await createDocument(request, { title });
    await openOverview(page);
    await expect(folderTile(page, name)).toHaveAccessibleName(`${name}, 0 documents`);
    const card = overviewCard(page, title);
    await expect(card).toBeVisible();
    // Earlier tests leave many cards, which can push the folders below the fold; a
    // drag across a scroll is unreliable, so make the window as tall as the page.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1440, height: Math.min(Math.max(height + 100, 900), 12_000) });
    await card.dragTo(folderTile(page, name));
    await expect(overviewCard(page, title)).toHaveCount(0);
    await expect(folderTile(page, name)).toHaveAccessibleName(/, 1 documents?$/);
    // It stays filed after a reload.
    await page.reload();
    await expect(overviewTabs(page)).toBeVisible();
    await expect(folderTile(page, name)).toHaveAccessibleName(/, 1 documents?$/);
    await expect(overviewCard(page, title)).toHaveCount(0);
  });
});

test.describe("Select mode", () => {
  test("moves the selected documents to a folder", async ({ page, request }) => {
    const folder = uid("Select folder");
    await createFolder(request, folder);
    const a = uid("Select move A");
    const b = uid("Select move B");
    await createDocument(request, { title: a });
    await createDocument(request, { title: b });
    await openOverview(page);

    const select = page.getByRole("button", { name: "Select", exact: true });
    await select.click();
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("checkbox", { name: `Select ${a}` }).check();
    // Clicking a card in Select mode toggles it rather than opening it.
    await overviewCard(page, b).click();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await expect(page.getByRole("checkbox", { name: `Select ${b}` })).toBeChecked();

    const bar = page.getByRole("toolbar", { name: "Selected documents" });
    await expect(bar).toBeVisible();
    await expect(bar.getByText("2 selected")).toBeVisible();
    await bar.getByRole("button", { name: /^Move to folder/ }).click();
    await page.getByRole("menuitem", { name: folder, exact: true }).click();
    await expect(overviewCard(page, a)).toHaveCount(0);
    await expect(overviewCard(page, b)).toHaveCount(0);
    await expect(folderTile(page, folder)).toHaveAccessibleName(`${folder}, 2 documents`);
  });

  test("deletes the selected documents after an inline confirm", async ({ page, request }) => {
    const a = uid("Select delete A");
    const b = uid("Select delete B");
    const idA = await createDocument(request, { title: a });
    await createDocument(request, { title: b });
    await openOverview(page);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("checkbox", { name: `Select ${a}` }).check();
    await page.getByRole("checkbox", { name: `Select ${b}` }).check();
    const bar = page.getByRole("toolbar", { name: "Selected documents" });
    await bar.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(bar.getByText("Delete 2 documents?")).toBeVisible();
    // Cancel keeps them.
    await bar.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(overviewCard(page, a)).toBeVisible();
    await bar.getByRole("button", { name: "Delete", exact: true }).click();
    await bar.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: `Select ${a}` })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: `Select ${b}` })).toHaveCount(0);
    expect((await request.get(`/api/documents/${idA}`)).status()).toBe(404);

    // With nothing left selected the bar may already have gone; Done ends Select mode otherwise.
    if (await bar.isVisible()) await bar.getByRole("button", { name: "Done", exact: true }).click();
    await expect(bar).toBeHidden();
    await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "false");
  });

  test("a failed bulk action keeps focus on a control, and the delete confirm stays open", async ({ page, request }) => {
    const a = uid("Select fails");
    await createDocument(request, { title: a });
    await page.route("**/api/documents/bulk", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await openOverview(page);
    const select = page.getByRole("button", { name: "Select", exact: true });
    await select.click();
    await page.getByRole("checkbox", { name: `Select ${a}` }).check();
    const bar = page.getByRole("toolbar", { name: "Selected documents" });

    await bar.getByRole("button", { name: "Delete", exact: true }).click();
    await bar.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Couldn.t/ })).toBeVisible();
    // The confirm is still there, with focus on its Delete button, to retry or cancel.
    await expect(bar.getByText("Delete 1 document?")).toBeVisible();
    await expect(bar.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await bar.getByRole("button", { name: "Cancel", exact: true }).click();

    await bar.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(overviewCard(page, a)).toBeVisible();
    await expect(select).toBeFocused();
  });
});

test("Archive moves a card to the archived view, and Restore brings it back", async ({ page, request }) => {
  const title = uid("Archive me");
  await createDocument(request, { title });
  await openOverview(page);
  await cardAction(page, title, "Archive");
  await expect(overviewCard(page, title)).toHaveCount(0);

  await main(page).locator("button, a").filter({ hasText: /^\s*Archived\s*$/ }).first().click();
  await expect(page).toHaveURL(/[?&]view=archived/);
  await expect(main(page).getByRole("heading", { name: "Archived", exact: true })).toBeVisible();
  await expect(overviewCard(page, title)).toBeVisible();
  await cardAction(page, title, "Restore");
  await expect(overviewCard(page, title)).toHaveCount(0);

  await main(page).getByRole("button", { name: "All documents" }).or(main(page).getByRole("link", { name: "All documents" })).first().click();
  await expect(overviewCard(page, title)).toBeVisible();
});

test("search lists matches from every folder and hides the folders", async ({ page, request }) => {
  const marker = uid("Needle");
  const folder = uid("Search folder");
  const folderId = await createFolder(request, folder);
  const filed = await createDocument(request, { title: `${marker} filed` });
  await patchDocument(request, filed, { doc_folder_id: folderId });
  await createDocument(request, { title: `${marker} loose` });
  const other = uid("Haystack");
  await createDocument(request, { title: other });

  await openOverview(page);
  await expect(overviewCard(page, other)).toBeVisible();
  await page.getByRole("searchbox", { name: "Search documents" }).fill(marker);
  await expect(overviewCard(page, `${marker} filed`)).toBeVisible();
  await expect(overviewCard(page, `${marker} loose`)).toBeVisible();
  await expect(overviewCard(page, other)).toHaveCount(0);
  await expect(folderTile(page, folder)).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search documents" }).fill("");
  await expect(overviewCard(page, other)).toBeVisible();
  await expect(folderTile(page, folder)).toBeVisible();
});

test("the Doc Gallery creates a typed document with its outline", async ({ page }) => {
  await openOverview(page);
  const button = page.getByRole("button", { name: "Doc Gallery" });
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await button.click();
  const gallery = page.getByRole("dialog", { name: "Doc Gallery" });
  await expect(gallery).toBeVisible();
  await expect(gallery.getByRole("link", { name: /Manage types/ })).toHaveAttribute("href", "/catalog");
  await gallery.getByRole("button", { name: /^General report/ }).click();
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/);
  await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
});

test("in a folder view the Doc Gallery files the new document into the folder", async ({ page, request }) => {
  const name = uid("Gallery folder");
  const folderId = await createFolder(request, name);
  await openOverview(page, `/?folder=${folderId}`);
  await page.getByRole("button", { name: "Doc Gallery" }).click();
  await page.getByRole("dialog", { name: "Doc Gallery" }).getByRole("button", { name: /^General report/ }).click();
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/);
  const id = page.url().split("/d/")[1];
  await expect.poll(async () => (await (await request.get(`/api/documents/${id}`)).json()).document.doc_folder_id).toBe(folderId);
});

test("New opens /new; typing gives it an address, and back on the overview its card shows", async ({ page }) => {
  await openOverview(page);
  const link = page.getByRole("link", { name: "New", exact: true });
  await expect(link).toHaveAttribute("href", /^\/new\?n=\d+$/);
  await link.click();
  await expect(page).toHaveURL(/\/new\?n=\d+$/);
  await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
  await expect(saveStatus(page)).toContainText("Not saved yet");
  await settle(page);

  const title = uid("From New");
  await page.locator("#doc-title").fill(title);
  await editorOf(page).click();
  await page.keyboard.type("Written on a new page.");
  await expect(saveStatus(page)).toContainText("Saved");
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/);

  await page.getByRole("link", { name: "Back to documents" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(overviewCard(page, title)).toBeVisible();
  await expect(overviewCard(page, title)).toContainText("Written on a new page.");
});

test("Back straight after a rename: the card catches up when the editor's last save lands", async ({ page, request }) => {
  const title = uid("Before back");
  const id = await createDocument(request, { title, content: [para(text("Some words."))] });
  await openDocument(page, id);
  // Hold the save back, so the overview's first fetch reads the old title.
  await page.route(`**/api/documents/${id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  const renamed = uid("After back");
  await page.locator("#doc-title").fill(renamed);
  await page.getByRole("link", { name: "Back to documents" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(overviewCard(page, renamed)).toBeVisible();
  await expect(overviewCard(page, title)).toHaveCount(0);
});

test("the user menu (dev bypass): Dev user, Usage, Document types and Appearance; no Team or Sign out", async ({ page }) => {
  await openOverview(page);
  let menu = await openUserMenu(page);
  await expect(menu).toContainText("Dev user");
  await expect(menu.getByRole("menuitem", { name: "Usage" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Document types" })).toBeVisible();
  for (const name of ["Light", "Dark", "System"]) await expect(menu.getByRole("menuitemradio", { name })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toHaveCount(0);
  await expect(menu.getByRole("menuitemradio", { name: "Personal workspace" })).toHaveCount(0);
  await expect(menu.getByText("Manage teams")).toHaveCount(0);

  // Appearance switches the theme.
  await menu.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  menu = await openUserMenu(page);
  await expect(menu.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  menu = await openUserMenu(page);
  await menu.getByRole("menuitem", { name: "Usage" }).click();
  await expect(page).toHaveURL(/\/usage$/);
  // The other pages' header: a back button to the overview, and the user menu.
  await page.getByRole("link", { name: "Back to documents" }).click();
  await expect(overviewTabs(page)).toBeVisible();
  menu = await openUserMenu(page);
  await menu.getByRole("menuitem", { name: "Document types" }).click();
  await expect(page).toHaveURL(/\/catalog$/);
});

test("Activity lists a document edit and a run, and the run opens the modal's Workflows tab on it", async ({ page, request }) => {
  const title = uid("Activity doc");
  const id = await createDocument(request, { title, content: [heading("Summary"), para(), heading("Costs"), para()] });
  await page.waitForTimeout(20);
  await patchDocument(request, id, { title: `${title} edited` });
  const edited = `${title} edited`;
  const res = await request.post(`/api/documents/${id}/workflows`, { data: { workflowId: "builtin:draft-all" } });
  expect(res.status(), await res.text()).toBe(202);
  const runId = (await res.json()).run.id as string;

  await openOverview(page);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();

  const docRow = page.getByRole("link", { name: new RegExp(`edited “${edited}”`) });
  await expect(docRow).toBeVisible();
  await expect(docRow).toHaveAttribute("href", `/d/${id}`);
  const runRow = page.getByRole("link", { name: new RegExp(`Draft all empty sections on “${edited}”`) });
  await expect(runRow).toBeVisible();
  await expect(runRow).toHaveAttribute("href", `/d/${id}?run=${encodeURIComponent(runId)}`);

  await runRow.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Workflows", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("heading", { name: "Draft all empty sections" })).toBeVisible();
  // The parameter is dropped once the modal is open, so a reload doesn't reopen it.
  await expect(page).toHaveURL(new RegExp(`/d/${id}$`));
});

test("a ?run= link naming another document's run opens it read-only, with a link to its own document", async ({ page, request }) => {
  const home = await createDocument(request, { title: uid("Run home"), content: [heading("Summary"), para(), heading("Costs"), para()] });
  const other = await createDocument(request, { title: uid("Run elsewhere"), content: [heading("Summary"), para()] });
  const res = await request.post(`/api/documents/${home}/workflows`, { data: { workflowId: "builtin:draft-all" } });
  expect(res.status(), await res.text()).toBe(202);
  const runId = (await res.json()).run.id as string;

  await page.goto(`/d/${other}?run=${encodeURIComponent(runId)}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Draft all empty sections" })).toBeVisible();
  await expect(dialog.getByText("This run belongs to another document")).toBeVisible();
  await expect(dialog.getByText("Read only", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open it in its document" })).toHaveAttribute("href", `/d/${home}?run=${encodeURIComponent(runId)}`);
  // Its proposed change is shown but can't be applied to (or discarded from) this document.
  await expect(dialog.getByRole("button", { name: "Apply to document" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Discard" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
});

test("on a phone the header's focus order follows its two rows: search, Activity, account, then the tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openOverview(page);
  const header = page.locator("header");
  await header.getByRole("searchbox").focus();
  await page.keyboard.press("Tab");
  await expect(header.getByRole("link", { name: "Activity", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(header.getByRole("button", { name: "Account menu" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(overviewTabs(page).getByRole("tab", { name: "Documents" })).toBeFocused();
  // Phones show icons; the labels are for screen readers.
  await expect(header.getByText("Select", { exact: true })).toHaveClass(/sr-only/);
});

/** Pairs of header controls (the search pill, tabs, buttons, links) whose boxes overlap, as "a / b". */
function overlappingHeaderControls(page: Page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("header label, header button, header a")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.parentElement?.closest("header label, header button, header a");
    });
    const name = (el: HTMLElement) => el.getAttribute("aria-label") || el.title || el.textContent?.trim() || el.tagName;
    const hits: string[] = [];
    els.forEach((a, i) => {
      const r = a.getBoundingClientRect();
      for (const b of els.slice(i + 1)) {
        const s = b.getBoundingClientRect();
        const w = Math.min(r.right, s.right) - Math.max(r.left, s.left);
        const h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
        if (w > 0.5 && h > 0.5) hits.push(`${name(a)} / ${name(b)}`);
      }
    });
    return hits;
  });
}

test("from tablet width up Select and New show their labels", async ({ page }) => {
  for (const width of [768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await openOverview(page);
    const header = page.locator("header");
    for (const name of ["Select", "New"]) {
      const label = header.getByText(name, { exact: true });
      await expect(label).toBeVisible();
      expect(await label.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(20);
    }
    // No row overflow at this width, and nothing in the header runs under
    // anything else (the search pill once spilled under the Documents tab).
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await overlappingHeaderControls(page)).toEqual([]);
  }
});

test("the header's controls never overlap, phone to wide", async ({ page }) => {
  for (const width of [375, 900, 1100, 1280, 2000]) {
    await page.setViewportSize({ width, height: 900 });
    await openOverview(page);
    await expect(page.getByRole("tab", { name: "Documents" })).toBeVisible();
    expect(await overlappingHeaderControls(page), `at ${width}px`).toEqual([]);
  }
});
