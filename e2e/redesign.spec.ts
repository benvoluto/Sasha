// Redesign 2 (redesign2-spec.md §7): the empty document's helper and its three
// ways in (upload sources, document type, tell me), the dog that hides it, the
// olive Tools card's rewrites and the Outline card's current section. The
// model replies come from the e2e stubs (src/lib/e2e/stub-models.ts):
// classify.prompt picks General report, draft.section and the two rewrite
// tasks answer with fixed sentences.

import { cardSlot, createDocument, editorOf, expect, fab, heading, helperOf, openCard, openDocument, openModal, openNewDocument, para, saveStatus, settle, test, text, uid, type Locator, type Page } from "./fixtures";

/** General report's sections (src/catalog/types/general-report.json); none is static, so tell me drafts them all. */
const GENERAL_REPORT = ["Introduction", "Background", "Findings", "Discussion", "Recommendations"];
const DRAFTED = "This section was drafted by the end-to-end test stub.";
const SELECTION_REWRITE = "This passage was rewritten by the end-to-end test stub.";
const SECTION_REWRITE = "This section was rewritten by the end-to-end test stub.";

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "element has a box").not.toBeNull();
  return box!;
}

/** The control at the centre of `locator` is the locator itself (nothing on top takes the click). */
async function expectHittable(locator: Locator) {
  expect(await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  })).toBe(true);
}

// Line start and end: on macOS Home and End go to the document's start and end.
const MAC = process.platform === "darwin";
const LINE_END = MAC ? "Meta+ArrowRight" : "End";
const SELECT_TO_LINE_START = MAC ? "Shift+Meta+ArrowLeft" : "Shift+Home";

/** Puts the caret at the end of the paragraph that contains `words`, with no selection. */
async function caretIn(page: Page, words: string) {
  await editorOf(page).locator("p", { hasText: words }).click();
  await page.keyboard.press(LINE_END);
}

test.describe("the helper on a new document", () => {
  test("shows, stays while typing in the first paragraph, hides after Enter and stays hidden after a reload", async ({ page }) => {
    await openNewDocument(page);
    const helper = helperOf(page);
    await expect(helper).toBeVisible();
    await expect(helper).toContainText("Start writing");
    for (const name of ["upload sources", "document type", "tell me"]) await expect(helper.getByRole("button", { name })).toBeVisible();

    await page.locator("#doc-title").fill(uid("Helper smoke"));
    await editorOf(page).click();
    await page.keyboard.type("The first paragraph is still being written");
    // Typing alone, inside the first paragraph, keeps it.
    await page.waitForTimeout(500);
    await expect(helper).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(helper).toBeHidden();
    await page.keyboard.type("A second paragraph.");
    await expect(saveStatus(page)).toHaveText("Saved");
    await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/);

    await page.reload();
    await expect(editorOf(page)).toContainText("A second paragraph.");
    await settle(page);
    await expect(helper).toHaveCount(0);
  });

  test("the dog hides it", async ({ page }) => {
    await openNewDocument(page);
    await expect(helperOf(page)).toBeVisible();
    const dog = page.getByRole("button", { name: "Hide Sasha's tips" });
    await dog.click();
    await expect(helperOf(page)).toHaveCount(0);
    // Once the helper is gone the dog is decoration again.
    await expect(dog).toHaveCount(0);
  });

  test("comes before the floating buttons in Tab order, as it sits to their left", async ({ page }) => {
    await openNewDocument(page);
    await expect(helperOf(page)).toBeVisible();
    await editorOf(page).click();
    await page.keyboard.press("Tab");
    await expect(helperOf(page).getByRole("button", { name: "upload sources" })).toBeFocused();
  });

  test("“upload sources” opens the Sources tab with the upload area ready", async ({ page }) => {
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "upload sources" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Sources", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("region", { name: "Upload files" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Upload source files" })).toBeFocused();
  });

  test("“document type” opens the Document Gallery, and General report lays out its outline", async ({ page }) => {
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "document type" }).click();
    const gallery = page.getByRole("dialog", { name: "Document Gallery" });
    await expect(gallery).toBeVisible();
    await expect(gallery.getByText(/No type yet/)).toBeVisible();
    await gallery.getByRole("button", { name: /^General report/ }).click();
    await expect(gallery).toBeHidden();
    await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
    // A typed document never shows the helper.
    await expect(helperOf(page)).toHaveCount(0);
    // Focus is in the document, just below the first heading, so typing lands there.
    await expect(editorOf(page)).toBeFocused();
    await page.keyboard.type("Typed");
    await expect(editorOf(page).locator("h2").first()).toHaveText(GENERAL_REPORT[0]);
    await expect(editorOf(page).locator("h2").first().locator("xpath=following-sibling::*[1]")).toContainText("Typed");
  });

  test("“tell me” picks a type, drafts each section, keeps the prompt in Notes, and one undo empties the document", async ({ page }) => {
    const prompt = `A progress report on the reading program ${uid("tell")}`;
    await openNewDocument(page);
    const helper = helperOf(page);
    await helper.getByRole("button", { name: "tell me" }).click();
    const field = page.getByRole("textbox", { name: "What doc would you like to create?" });
    await expect(field).toBeFocused();
    await field.fill(prompt);
    await page.getByRole("button", { name: "Create document" }).click();

    await expect(helper.getByText(`Drafted ${GENERAL_REPORT.length} of ${GENERAL_REPORT.length} sections`)).toBeVisible({ timeout: 90_000 });
    await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
    // Each draftable section's body is the stub's paragraph.
    await expect(editorOf(page).locator("p", { hasText: DRAFTED })).toHaveCount(GENERAL_REPORT.length);
    for (const name of GENERAL_REPORT) {
      await expect(editorOf(page).locator(`h2:text-is("${name}") + p`)).toContainText(DRAFTED);
    }
    // The empty title takes the stub's suggestion.
    await expect(page.locator("#doc-title")).toHaveValue("Stub report");
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");

    await helper.getByRole("button", { name: "Done" }).click();
    await expect(helperOf(page)).toHaveCount(0);

    const dialog = await openModal(page, "Notes");
    await expect(dialog.getByRole("textbox", { name: "Notes" })).toHaveValue(new RegExp(prompt));
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The outline and the drafts were one history step: a single undo goes back to the empty document.
    await editorOf(page).locator("p").first().click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editorOf(page).locator("h2")).toHaveCount(0);
    await expect(editorOf(page)).toHaveText("");
  });

  test("the result card's Undo takes the drafts back, and no notice covers the card", async ({ page }) => {
    await openNewDocument(page);
    const helper = helperOf(page);
    await helper.getByRole("button", { name: "tell me" }).click();
    await page.getByRole("textbox", { name: "What doc would you like to create?" }).fill(`A short report ${uid("undo")}`);
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(helper.getByText(/^Drafted \d+ of \d+ sections/)).toBeVisible({ timeout: 90_000 });
    await expect(helper).toContainText("Undo removes the text; the type and notes stay.");
    // The card is the one place the result is reported (it used to be repeated in a notice on top of it).
    await expect(page.getByText(/from your request/)).toHaveCount(0);
    await helper.getByRole("button", { name: "Undo" }).click();
    await expect(helperOf(page)).toHaveCount(0);
    await expect(editorOf(page).locator("h2")).toHaveCount(0);
    await expect(editorOf(page)).toHaveText("");
  });
});

test.describe("the helper's layout", () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 900, height: 900 },
  ]) {
    test(`stays clear of the floating buttons at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openNewDocument(page);
      const helper = helperOf(page);
      const pills = page.getByRole("group", { name: "Document panels" });
      const tips = helper.locator("p");
      await expect(tips).toBeVisible();
      expect(intersects(await boxOf(tips), await boxOf(pills))).toBe(false);
      const tellMe = helper.getByRole("button", { name: "tell me" });
      await expectHittable(tellMe);

      await tellMe.click();
      const form = helper.locator("form");
      await expect(form).toBeVisible();
      expect(intersects(await boxOf(form), await boxOf(pills))).toBe(false);
      const cancel = form.getByRole("button", { name: "Cancel" });
      await expectHittable(cancel);
      await cancel.click();
      await expect(form).toHaveCount(0);
    });
  }

  test("steps aside while a drawer covers the text, and comes back when it closes", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await openNewDocument(page);
    await expect(helperOf(page)).toBeVisible();
    const card = await openCard(page, "Tools");
    await expect(helperOf(page)).toHaveCount(0);
    await card.getByRole("button", { name: "Close tools" }).click();
    await expect(fab(page, "Tools")).toBeVisible();
    await expect(helperOf(page)).toBeVisible();
  });

  test("never shows on a document that opens with one paragraph of text", async ({ page, request }) => {
    const id = await createDocument(request, { title: uid("One paragraph"), content: [para(text("An existing paragraph of text."))] });
    await openDocument(page, id);
    await expect(editorOf(page)).toContainText("An existing paragraph of text.");
    await expect(helperOf(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hide Sasha's tips" })).toHaveCount(0);
  });
});

test.describe("the Document Gallery on a phone on its side", () => {
  test("scrolls its search and cards into reach rather than clipping them", async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await openNewDocument(page);
    await page.locator("header").getByRole("button", { name: /^Document Gallery/ }).click();
    const gallery = page.getByRole("dialog", { name: "Document Gallery" });
    await expect(gallery).toBeVisible();
    const search = gallery.getByRole("textbox", { name: "Search types" });
    await search.scrollIntoViewIfNeeded();
    await expectHittable(search);
    const card = gallery.getByRole("button", { name: /^General report/ });
    await card.scrollIntoViewIfNeeded();
    await expectHittable(card);
    await card.click();
    await expect(gallery).toBeHidden();
    await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
  });
});

test.describe("the header", () => {
  for (const width of [640, 800, 1024]) {
    test(`fits its buttons beside the title at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openNewDocument(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const title = await boxOf(page.locator("#doc-title"));
      for (const name of ["Sources", "Document Gallery", "Share & Export"]) {
        const button = page.locator("header").getByRole("button", { name, exact: true });
        // Its name on hover too, for when the header is too narrow for the labels.
        await expect(button).toHaveAttribute("title", name);
        const box = await boxOf(button);
        expect(intersects(title, box), `${name} clear of the title`).toBe(false);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    });
  }
});

test.describe("while “tell me” drafts", () => {
  test("the Tools card can't change the document", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Hold every section draft until the checks below are done.
    await page.route("**/api/documents/*/sections/*/generate", async (route) => {
      await gate;
      await route.continue();
    });
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "tell me" }).click();
    await page.getByRole("textbox", { name: "What doc would you like to create?" }).fill(`A report on the garden project ${uid("lock")}`);
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(helperOf(page).getByText(/^Drafting .*: 0 of \d+ sections$/)).toBeVisible({ timeout: 90_000 });

    const card = await openCard(page, "Tools");
    await expect(card.getByText("Sasha is drafting the document. Wait for it to finish or press Stop.")).toBeVisible();
    await expect(card.getByRole("button", { name: /^Draft/ })).toHaveAttribute("aria-disabled", "true");
    for (const chip of await card.getByRole("group", { name: "Rewrite as…" }).getByRole("button").all()) await expect(chip).toHaveAttribute("aria-disabled", "true");

    release();
    await expect(helperOf(page).getByText(/^Drafted /)).toBeVisible({ timeout: 90_000 });
    await expect(card.getByText("Sasha is drafting the document.")).toHaveCount(0);
  });
  test("the section dividers can't add or delete sections, and Stop keeps keyboard focus", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/documents/*/sections/*/generate", async (route) => {
      await gate;
      await route.continue();
    });
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "tell me" }).click();
    await page.getByRole("textbox", { name: "What doc would you like to create?" }).fill(`A report on the bridge project ${uid("divider")}`);
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(helperOf(page).getByText(/^Drafting .*: 0 of \d+ sections$/)).toBeVisible({ timeout: 90_000 });

    await expect(editorOf(page).locator(".section-divider").first()).toBeAttached();
    // By class: hidden buttons leave the accessibility tree, so a role query wouldn't find them.
    const deletes = editorOf(page).locator('.section-divider-btn[aria-label="Delete the section below"]');
    await expect(deletes).toHaveCount(GENERAL_REPORT.length - 1);
    for (const b of await editorOf(page).locator(".section-divider-btn").all()) await expect(b).toBeHidden();

    const stop = helperOf(page).getByRole("button", { name: "Stop" });
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(stop).toHaveAttribute("aria-disabled", "true");
    await expect(stop).toBeFocused();

    release();
    await expect(helperOf(page).getByText(/^Drafted /)).toBeVisible({ timeout: 90_000 });
    await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
    await expect(editorOf(page).getByRole("button", { name: "Delete the section below" }).first()).toBeVisible();
  });
});

test.describe("while “tell me” chooses a type", () => {
  test("the document and the Document Gallery wait for it", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/documents/*/start-from-prompt", async (route) => {
      await gate;
      await route.continue();
    });
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "tell me" }).click();
    await page.getByRole("textbox", { name: "What doc would you like to create?" }).fill(`A report on the orchard project ${uid("choose")}`);
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(helperOf(page).getByText(/Choosing a document type/)).toBeVisible({ timeout: 30_000 });
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "false");

    // A type picked meanwhile would be overwritten by the one "tell me" picks: the gallery says to wait.
    await page.locator("header").getByRole("button", { name: /^Document Gallery/ }).click();
    const gallery = page.getByRole("dialog", { name: "Document Gallery" });
    await gallery.getByRole("button", { name: /^General report/ }).click();
    await expect(gallery.getByText(/Sasha is choosing a document type/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gallery).toBeHidden();

    release();
    await expect(helperOf(page).getByText(/^Drafted /)).toBeVisible({ timeout: 90_000 });
    await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
  });
});

test.describe("the Tools card", () => {
  test("a chip rewrites the selection, or the caret's section when nothing is selected", async ({ page, request }) => {
    const id = await createDocument(request, {
      title: uid("Tools rewrite"),
      content: [heading("Summary", 2, "s_e2esum1"), para(text("Original summary words.")), heading("Costs", 2, "s_e2ecost"), para(text("Original cost words."))],
    });
    await openDocument(page, id);
    const tools = await openCard(page, "Tools");
    await expect(tools.getByRole("heading", { name: "Tools" })).toBeVisible();
    await expect(tools.getByRole("button", { name: "Close tools" })).toBeVisible();

    // A selection: the summary paragraph, start to end.
    await caretIn(page, "Original summary words.");
    await page.keyboard.press(SELECT_TO_LINE_START);
    await expect(tools.getByText("Rewrites your selection.")).toBeVisible();
    await tools.getByRole("button", { name: "More concise" }).click();
    await expect(editorOf(page)).toContainText(SELECTION_REWRITE, { timeout: 60_000 });
    await expect(editorOf(page)).not.toContainText("Original summary words.");
    await expect(editorOf(page)).toContainText("Original cost words.");
    // Only the paragraph's words were selected: the heading stays.
    await expect(editorOf(page).locator('h2:text-is("Summary") + p')).toHaveText(SELECTION_REWRITE);

    // No selection, the caret in Costs: the whole section is rewritten.
    await caretIn(page, "Original cost words.");
    await expect(tools.getByText("Rewrites “Costs”.")).toBeVisible();
    await tools.getByRole("button", { name: "Simple language" }).click();
    await expect(editorOf(page).locator('h2:text-is("Costs") + p')).toContainText(SECTION_REWRITE, { timeout: 60_000 });
    await expect(editorOf(page)).not.toContainText("Original cost words.");
    await expect(editorOf(page)).toContainText(SELECTION_REWRITE);

    // A section with one after it: the caret stays in it once its body is
    // replaced, so the card still names it (not the next heading).
    await caretIn(page, SELECTION_REWRITE);
    await expect(tools.getByText("Rewrites “Summary”.")).toBeVisible();
    await tools.getByRole("button", { name: "Add details" }).click();
    await expect(editorOf(page).locator('h2:text-is("Summary") + p')).toContainText(SECTION_REWRITE, { timeout: 60_000 });
    await expect(tools.getByText("Rewrites “Summary”.")).toBeVisible();

    // The card's X brings the Tools button back.
    await tools.getByRole("button", { name: "Close tools" }).click();
    await expect(cardSlot(page, "Tools")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Document panels" }).getByRole("button", { name: "Tools", exact: true })).toBeVisible();
  });
});

test.describe("the Outline card", () => {
  test("marks the caret's section as the current location", async ({ page, request }) => {
    const id = await createDocument(request, {
      title: uid("Outline current"),
      content: [heading("Summary", 2, "s_e2esum1"), para(text("Summary body.")), heading("Costs", 2, "s_e2ecost"), para(text("Costs body."))],
    });
    await openDocument(page, id);
    await caretIn(page, "Costs body.");
    const outline = await openCard(page, "Outline");
    await expect(outline.getByRole("heading", { name: "Outline" })).toBeVisible();
    const current = outline.locator('[aria-current="location"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(/^Costs/);

    await caretIn(page, "Summary body.");
    await expect(current).toHaveText(/^Summary/);
  });
});
