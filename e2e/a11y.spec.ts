// Axe scans of the main screens (phase9-spec.md §4.2), in both colour schemes
// (the light and dark projects in playwright.config.ts; next-themes follows
// the emulated prefers-color-scheme, so the dark project scans the .dark
// tokens). Serious and critical violations fail; every violation is printed
// with its rule, impact, targets and help URL, and attached to the report as
// JSON. No rule is disabled.
// Redesign 3 (redesign3-spec.md §18) adds the documents overview, the Notes
// tab and note dialog, Select mode, folders, the archive, the Doc Gallery,
// the user menu, Activity, /new, and the editor card's Agents and Outline panels.

import {
  createDocument,
  createFolder,
  createNote,
  expect,
  expectNoA11yViolations,
  heading,
  helperOf,
  openDocument,
  openGallery,
  openModal,
  openNewDocument,
  openOverview,
  openPanel,
  openShareExport,
  openUserMenu,
  overviewCard,
  panelButton,
  panelRegion,
  para,
  patchDocument,
  settle,
  test,
  text,
  uid,
  type Page,
} from "./fixtures";

const TABS = ["Notes", "Sources", "Data", "Suggestions", "Workflows"] as const;

async function sampleDocument(request: Parameters<typeof createDocument>[0]) {
  return createDocument(request, {
    title: uid("Axe sample"),
    content: [heading("Summary"), para(text("We ask for a replacement centrifuge because the current unit failed its safety inspection.")), heading("Costs"), para(text("Centrifuge 4,200 and installation 300, total 4,500."))],
  });
}

/** Something on every overview screen: a typed and an untitled card, a folder with a document, a note and a document's notes. */
async function seedOverview(request: Parameters<typeof createDocument>[0]) {
  const typed = uid("Axe typed card");
  await createDocument(request, { title: typed, type_key: "proposal", content: [para(text("The first line of a proposal."))] });
  await createDocument(request, { title: "", content: [para(text(uid("Axe untitled")))] });
  const folderId = await createFolder(request, uid("Axe folder"));
  const filed = await createDocument(request, { title: uid("Axe filed") });
  await patchDocument(request, filed, { doc_folder_id: folderId });
  const archived = await createDocument(request, { title: uid("Axe archived") });
  await patchDocument(request, archived, { archived: true });
  const noteTitle = uid("Axe note");
  await createNote(request, `${noteTitle}\nThe rest of the note.`);
  const withNotes = await createDocument(request, { title: uid("Axe doc notes") });
  await patchDocument(request, withNotes, { notes: "Doc notes title\nMore notes." });
  return { typed, folderId, noteTitle };
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe("axe: overview", () => {
  test("Documents tab", async ({ page, request }, testInfo) => {
    const { typed } = await seedOverview(request);
    await openOverview(page);
    await expect(overviewCard(page, typed)).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "overview-documents");
  });

  test("Notes tab", async ({ page, request }, testInfo) => {
    const { noteTitle } = await seedOverview(request);
    await openOverview(page, "/?tab=notes");
    await expect(page.getByRole("tabpanel", { name: "Notes" }).getByRole("button", { name: noteTitle })).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "overview-notes");
  });

  test("the Notes tab's error lines on the page background", async ({ page }, testInfo) => {
    // The list fails to load; the error sits on --page-bg, outside any card.
    await page.route("**/api/notes", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 500, body: "{}" }) : route.fallback()));
    await openOverview(page, "/?tab=notes");
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load notes." })).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "overview-notes-error");
  });

  test("Select mode with its bar", async ({ page, request }, testInfo) => {
    const { typed } = await seedOverview(request);
    await openOverview(page);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("checkbox", { name: `Select ${typed}` }).check();
    await expect(page.getByRole("toolbar", { name: "Selected documents" })).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "overview-select");
  });

  test("a folder view", async ({ page, request }, testInfo) => {
    const { folderId } = await seedOverview(request);
    await openOverview(page, `/?folder=${folderId}`);
    await expect(page.getByRole("button", { name: "All documents" }).or(page.getByRole("link", { name: "All documents" })).first()).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "overview-folder");
  });

  test("the archived view", async ({ page, request }, testInfo) => {
    await seedOverview(request);
    await openOverview(page, "/?view=archived");
    await expect(page.locator("#main-content").getByRole("heading", { name: "Archived" })).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "overview-archived");
  });

  test("the Doc Gallery dialog", async ({ page }, testInfo) => {
    await openOverview(page);
    await page.getByRole("button", { name: "Doc Gallery" }).click();
    const gallery = page.getByRole("dialog", { name: "Doc Gallery" });
    await expect(gallery.getByRole("button", { name: /^General report/ })).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "overview-gallery");
  });

  test("the user menu open", async ({ page }, testInfo) => {
    await openOverview(page);
    const menu = await openUserMenu(page);
    await expect(menu.getByRole("menuitem", { name: "Usage" })).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "user-menu");
  });

  test("the note dialog", async ({ page, request }, testInfo) => {
    const { noteTitle } = await seedOverview(request);
    await openOverview(page, "/?tab=notes");
    await page.getByRole("tabpanel", { name: "Notes" }).getByRole("button", { name: noteTitle }).click();
    const dialog = page.getByRole("dialog", { name: "Note" });
    await expect(dialog.getByRole("button", { name: "Start a document" })).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "note-dialog");
  });

  test("on a phone (390×844)", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { typed } = await seedOverview(request);
    await openOverview(page);
    await expect(overviewCard(page, typed)).toBeVisible();
    await noHorizontalScroll(page);
    await expectNoA11yViolations(page, testInfo, "overview-phone");
  });
});

test("axe: /activity", async ({ page, request }, testInfo) => {
  const id = await sampleDocument(request);
  await patchDocument(request, id, { title: uid("Axe activity") });
  const res = await request.post(`/api/documents/${id}/workflows`, { data: { workflowId: "builtin:draft-all" } });
  expect(res.status(), await res.text()).toBe(202);
  await page.goto("/activity");
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await settle(page);
  await expectNoA11yViolations(page, testInfo, "activity");
});

test.describe("axe: editor", () => {
  test("/new", async ({ page }, testInfo) => {
    await openNewDocument(page);
    await expectNoA11yViolations(page, testInfo, "editor-new");
  });

  test("a saved document with text", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    await expectNoA11yViolations(page, testInfo, "editor-saved");
  });

  test("Agents and Outline open beside the text", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    // The caret in a section, so the Agents chips are enabled and the outline has a current row.
    await page.locator('.ProseMirror[aria-label="Document"] p').first().click();
    await openPanel(page, "Agents");
    await openPanel(page, "Outline");
    await expect(panelRegion(page, "Agents")).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "panels-inline");
  });

  test("a panel in the phone sheet (390×844)", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDocument(page, await sampleDocument(request));
    await noHorizontalScroll(page);
    await expect(panelButton(page, "Agents")).toBeVisible();
    await openPanel(page, "Agents");
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "panels-sheet");
  });

  for (const tab of TABS) {
    test(`document modal: ${tab} tab`, async ({ page, request }, testInfo) => {
      await openDocument(page, await sampleDocument(request));
      await openModal(page, tab);
      await settle(page);
      await expectNoA11yViolations(page, testInfo, `modal-${tab.toLowerCase()}`);
    });
  }

  test("learn review (stubbed learn.extract)", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    const dialog = await openModal(page, "Sources");
    await dialog.getByRole("button", { name: "Learn a type from these examples" }).click();
    const learn = page.getByRole("dialog", { name: /Learn a type from examples/ });
    await expect(learn).toBeVisible();
    await learn.getByRole("button", { name: /^Learn from/ }).click();
    await expect(learn.getByText("Check the draft against the examples.")).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "learn-review");
  });

  test("Doc Gallery: an untyped document", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    const gallery = await openGallery(page);
    await expect(gallery.getByText(/No type yet/)).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "gallery-untyped");
  });

  test("Doc Gallery: a typed document", async ({ page, request }, testInfo) => {
    const id = await createDocument(request, { title: uid("Axe typed"), type_key: "general-report", content: [heading("Introduction"), para(text("Why this report exists."))] });
    await openDocument(page, id);
    const gallery = await openGallery(page);
    await expect(gallery.getByRole("button", { name: "No type (freeform)" })).toBeVisible();
    await expect(gallery.locator('[aria-current="true"]')).toHaveCount(1);
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "gallery-typed");
  });

  test("Share & Export dialog", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    const dialog = await openShareExport(page);
    await expect(dialog.getByRole("button", { name: "Word (.docx)", exact: true })).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "share-export");
  });

  test("helper: a new document", async ({ page }, testInfo) => {
    await openNewDocument(page);
    await expect(helperOf(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide Sasha's tips" })).toBeVisible();
    await expectNoA11yViolations(page, testInfo, "helper");
  });

  test("helper: the tell-me form", async ({ page }, testInfo) => {
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "tell me" }).click();
    await expect(page.getByRole("textbox", { name: "What doc would you like to create?" })).toBeFocused();
    await expectNoA11yViolations(page, testInfo, "tell-me-form");
  });

  test("helper: the tell-me done state (stubbed classify.prompt and drafts)", async ({ page }, testInfo) => {
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "tell me" }).click();
    await page.getByRole("textbox", { name: "What doc would you like to create?" }).fill("A short report on our community garden's first season");
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(helperOf(page).getByText(/^Drafted \d+ of \d+ sections/)).toBeVisible({ timeout: 90_000 });
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "tell-me-done");
  });
});

for (const path of ["/library", "/catalog", "/workflows", "/usage"]) {
  test(`axe: page ${path}`, async ({ page }, testInfo) => {
    const res = await page.goto(path);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("main").first()).toBeVisible();
    // The redesign 3 header: a back button to the overview and the user menu.
    await expect(page.getByRole("link", { name: "Back to documents" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, `page${path.replace(/\//g, "-")}`);
  });
}
