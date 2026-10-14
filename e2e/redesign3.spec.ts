// Redesign 3's editor card (redesign3-spec.md §10–§15): the header, the
// toolbar row's save status, the section dividers, and the right column's
// Sources pill and Agents and Outline panels; plus the empty document's
// helper and "tell me" from redesign 2, which survive. The model replies come
// from the e2e stubs (src/lib/e2e/stub-models.ts): classify.prompt picks
// General report, draft.section and the two rewrite tasks answer with fixed
// sentences, and classify.type suggests nothing (the classifier hint test
// answers /classify itself).

import {
  createDocument,
  editorOf,
  expect,
  heading,
  helperOf,
  openDocument,
  openGallery,
  openModal,
  openNewDocument,
  openPanel,
  overviewCard,
  overviewTabs,
  panelButton,
  panelGroup,
  panelRegion,
  para,
  saveStatus,
  settle,
  test,
  text,
  uid,
  type Locator,
  type Page,
} from "./fixtures";

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
  expect(
    await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    }),
  ).toBe(true);
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

const typeSelect = (page: Page) => page.locator("#outline-type-select");

/** A saved, untyped document with two sections of text. */
async function textDocument(page: Page, name: string) {
  return createDocument(page.request, {
    title: uid(name),
    content: [heading("Summary", 2, "s_e2esum1"), para(text("Summary body words.")), heading("Costs", 2, "s_e2ecost"), para(text("Costs body words."))],
  });
}

test.describe("the editor card", () => {
  test("header: back button, centred title and Share & Export; no Sources or Gallery buttons in it", async ({ page, request }) => {
    const title = uid("Header doc");
    await openDocument(page, await createDocument(request, { title }));
    const back = page.getByRole("link", { name: "Back to documents" });
    await expect(back).toHaveAttribute("href", "/");
    await expect(page.locator("#doc-title")).toHaveValue(title);
    await expect(page.getByRole("button", { name: "Share & Export", exact: true })).toBeVisible();
    await expect(page.locator("header").getByRole("button", { name: "Sources" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Document Gallery/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Documents", exact: true })).toHaveCount(0);

    await back.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(overviewTabs(page)).toBeVisible();
    await expect(overviewCard(page, title)).toBeVisible();
  });

  for (const width of [640, 800, 1024]) {
    test(`the header fits beside the title at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openNewDocument(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const title = await boxOf(page.locator("#doc-title"));
      for (const control of [page.getByRole("button", { name: "Share & Export", exact: true }), page.getByRole("link", { name: "Back to documents" })]) {
        const box = await boxOf(control);
        expect(intersects(title, box)).toBe(false);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    });
  }

  test("the paragraph-style picker is named for the current style", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Style picker"));
    await caretIn(page, "Summary body words.");
    const picker = page.getByRole("button", { name: /^Paragraph style: / });
    await expect(picker).toHaveAccessibleName("Paragraph style: Paragraph");
    await editorOf(page).locator("h2", { hasText: "Costs" }).click();
    await expect(picker).toHaveAccessibleName("Paragraph style: Heading 2");
    await picker.click();
    const items = page.getByRole("menuitemradio");
    await expect(items).toHaveText(["Paragraph", "Heading 1", "Heading 2", "Heading 3", "Quote", "Code block"]);
    await expect(page.getByRole("menuitemradio", { name: "Heading 2" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "Heading 3" }).click();
    await expect(editorOf(page).locator("h3", { hasText: "Costs" })).toBeVisible();
  });

  test("save status: Not saved yet, then Saved just now, then a relative time", async ({ page }) => {
    await page.clock.install();
    await openNewDocument(page);
    await expect(saveStatus(page)).toContainText("Not saved yet");
    await page.locator("#doc-title").fill(uid("Saved ago"));
    await editorOf(page).click();
    await page.keyboard.type("Some words to save.");
    await expect(saveStatus(page)).toContainText("Saved");
    await expect(saveStatus(page)).toContainText("Saved just now");
    await page.clock.fastForward("03:00");
    await expect(saveStatus(page)).toContainText(/Saved [23] min ago/);
  });

  test("section dividers add a section, and delete one with an Undo", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Dividers"));
    await expect(editorOf(page).locator("h2")).toHaveText(["Summary", "Costs"]);

    await editorOf(page).getByRole("button", { name: "Delete the section below" }).first().click();
    await expect(editorOf(page).locator("h2")).toHaveText(["Summary"]);
    await expect(editorOf(page)).not.toContainText("Costs body words.");
    const notice = page.getByText("Deleted “Costs”.");
    await expect(notice).toBeVisible();
    // The notice's Undo (the toolbar has an Undo button too).
    await notice.locator("..").getByRole("button", { name: "Undo", exact: true }).click();
    await expect(editorOf(page).locator("h2")).toHaveText(["Summary", "Costs"]);
    await expect(editorOf(page)).toContainText("Costs body words.");

    await editorOf(page).getByRole("button", { name: "Add a section here" }).first().click();
    await expect(editorOf(page).locator("h2")).toHaveText(["Summary", "New section", "Costs"]);
  });
});

test.describe("the right column", () => {
  test("Sources pill, then Agents and Outline buttons; both panels start closed", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Panels closed"));
    await expect(panelGroup(page).getByRole("button")).toHaveText(["Sources", "Agents", "Outline"]);
    for (const name of ["Agents", "Outline"] as const) {
      await expect(panelButton(page, name)).toHaveAttribute("aria-expanded", "false");
      await expect(panelRegion(page, name)).toHaveCount(0);
    }
    await expect(panelGroup(page).getByRole("button", { name: "Sources" })).toHaveAttribute("aria-haspopup", "dialog");
  });

  test("each document remembers which panels were open", async ({ page }) => {
    const a = await textDocument(page, "Memory A");
    const b = await textDocument(page, "Memory B");
    await openDocument(page, a);
    await openPanel(page, "Outline");
    await expect.poll(() => page.evaluate((id) => localStorage.getItem(`sasha.panels.${id}`), a)).toContain('"outline":true');

    await openDocument(page, b);
    await expect(panelRegion(page, "Outline")).toHaveCount(0);
    await expect(panelRegion(page, "Agents")).toHaveCount(0);

    await openDocument(page, a);
    await expect(panelRegion(page, "Outline")).toBeVisible();
    await expect(panelRegion(page, "Agents")).toHaveCount(0);
    await panelRegion(page, "Outline").getByRole("button", { name: "Close outline" }).click();
    await expect(panelButton(page, "Outline")).toBeFocused();
    await page.reload();
    await expect(editorOf(page)).toBeVisible();
    await settle(page);
    await expect(panelRegion(page, "Outline")).toHaveCount(0);
  });

  test("a new, unsaved document starts with both panels closed", async ({ page }) => {
    await openNewDocument(page);
    await expect(panelButton(page, "Agents")).toBeVisible();
    await expect(panelButton(page, "Outline")).toBeVisible();
  });
});

test.describe("the Outline panel's type select", () => {
  async function chooseType(page: Page, label: string) {
    const outline = await openPanel(page, "Outline");
    await typeSelect(page).selectOption({ label });
    const prompt = outline.getByRole("group", { name: `Change to ${label}` });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("button").first()).toBeFocused();
    return prompt;
  }

  test("on an empty document applies the type straight away", async ({ page }) => {
    await openNewDocument(page);
    const outline = await openPanel(page, "Outline");
    await expect(typeSelect(page)).toHaveAccessibleName("Document type");
    await expect(outline.getByRole("button", { name: "Choose a type" })).toHaveCount(0);
    await typeSelect(page).selectOption({ label: "General report" });
    await expect(outline.getByRole("group", { name: /^Change to/ })).toHaveCount(0);
    await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
  });

  test("Apply outline merges the type's sections into the text", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Type apply"));
    const prompt = await chooseType(page, "General report");
    await expect(prompt.getByRole("button")).toHaveText(["Apply outline", "Restructure", "Just set type", "Cancel"]);
    await prompt.getByRole("button", { name: "Apply outline" }).click();
    await expect(prompt).toBeHidden();
    for (const h of GENERAL_REPORT) await expect(editorOf(page).locator("h2", { hasText: h })).toHaveCount(1);
    await expect(editorOf(page)).toContainText("Summary body words.");
    await expect(typeSelect(page)).toHaveValue("general-report");
  });

  test("Restructure opens the Workflows tab with the restructure workflow", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Type restructure"));
    const prompt = await chooseType(page, "General report");
    await prompt.getByRole("button", { name: "Restructure" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("tab", { name: "Workflows", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByText(/Restructure/).first()).toBeVisible();
    // Nothing changed in the text yet.
    await page.keyboard.press("Escape");
    await expect(editorOf(page).locator("h2")).toHaveText(["Summary", "Costs"]);
  });

  test("Just set type changes the type and leaves the text alone", async ({ page }) => {
    const id = await textDocument(page, "Type just set");
    await openDocument(page, id);
    const prompt = await chooseType(page, "General report");
    await prompt.getByRole("button", { name: "Just set type" }).click();
    await expect(page.getByText("Type set to General report.")).toBeVisible();
    await expect(editorOf(page).locator("h2")).toHaveText(["Summary", "Costs"]);
    await expect(typeSelect(page)).toHaveValue("general-report");
    await expect.poll(async () => (await (await page.request.get(`/api/documents/${id}`)).json()).document.type_key).toBe("general-report");

    // "No type" goes back to freeform with no prompt.
    await typeSelect(page).selectOption({ label: "No type" });
    await expect(panelRegion(page, "Outline").getByRole("group", { name: /^Change to/ })).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`/api/documents/${id}`)).json()).document.type_key).toBeNull();
  });

  test("Cancel puts the select back", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Type cancel"));
    const prompt = await chooseType(page, "General report");
    await prompt.getByRole("button", { name: "Cancel" }).click();
    await expect(prompt).toBeHidden();
    await expect(typeSelect(page)).toHaveValue("");
    await expect(editorOf(page).locator("h2")).toHaveText(["Summary", "Costs"]);
  });

  test("the classifier's hint offers its type: Use it follows the same prompt, Dismiss hides it", async ({ page }) => {
    const id = await textDocument(page, "Classifier hint");
    // classify.type's stub suggests nothing, so answer /classify with a stored suggestion.
    const view = {
      type_key: null,
      type_source: null,
      type_confidence: null,
      last_classified_at: new Date().toISOString(),
      state: { last: { candidates: [{ key: "proposal", confidence: 0.95, why: "It asks for funding." }], freeform: false, at: new Date().toISOString(), trigger: "content" }, dismissals: {}, words_at_last_run: 12 },
    };
    await page.route(`**/api/documents/${id}/classify`, (route) => route.fulfill({ json: route.request().method() === "GET" ? { view } : { ran: true, view } }));
    await page.route(`**/api/documents/${id}/classify/dismiss`, (route) => route.fulfill({ json: { view: { ...view, state: { ...view.state, last: null } } } }));
    await openDocument(page, id);
    const outline = await openPanel(page, "Outline");
    const hint = outline.getByText("Sasha suggests Proposal");
    await expect(hint).toBeVisible();
    await outline.getByRole("button", { name: "Use it" }).click();
    const prompt = outline.getByRole("group", { name: "Change to Proposal" });
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Cancel" }).click();
    await outline.getByRole("button", { name: "Dismiss" }).click();
    await expect(hint).toBeHidden();
  });

  test("the helper's “document type” opens the Outline panel and focuses the select", async ({ page }) => {
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "document type" }).click();
    await expect(panelRegion(page, "Outline")).toBeVisible();
    await expect(typeSelect(page)).toBeFocused();
  });

  test("See all document types opens the Doc Gallery, whose card lays out the outline", async ({ page }) => {
    await openNewDocument(page);
    const gallery = await openGallery(page);
    await expect(gallery.getByText(/No type yet/)).toBeVisible();
    await gallery.getByRole("button", { name: /^General report/ }).click();
    await expect(gallery).toBeHidden();
    await expect(editorOf(page).locator("h2")).toHaveText(GENERAL_REPORT);
    await expect(helperOf(page)).toHaveCount(0);
    await expect(typeSelect(page)).toHaveValue("general-report");
  });

  test("marks the caret's section as the current location", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Outline current"));
    await caretIn(page, "Costs body words.");
    const outline = await openPanel(page, "Outline");
    await expect(outline.getByRole("heading", { name: "Outline" })).toBeFocused();
    const current = outline.locator('[aria-current="location"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(/Costs/);
    await caretIn(page, "Summary body words.");
    await expect(current).toHaveText(/Summary/);
    // The current row shows the mockup's outlined pill (its border is drawn, not transparent); the others don't.
    const borderOf = (row: Locator) => row.locator("xpath=..").evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(await borderOf(current)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await borderOf(outline.getByRole("button", { name: /^Costs/ }))).toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("the Agents panel", () => {
  test("has the four rewrite chips, Strong language among them, and rewrites the selection or the caret's section", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Agents rewrite"));
    const agents = await openPanel(page, "Agents");
    await expect(agents.getByRole("heading", { name: "Agents" })).toBeFocused();
    const chips = agents.getByRole("group", { name: "Rewrite as…" }).getByRole("button");
    await expect(chips).toHaveText(["More concise", "Simple language", "Strong language", "Add details"]);
    await expect(agents.getByRole("textbox", { name: "Custom request" })).toHaveAttribute("placeholder", "Try any prompt…");

    await caretIn(page, "Summary body words.");
    await page.keyboard.press(SELECT_TO_LINE_START);
    await expect(agents.getByText("Rewrites your selection.")).toBeVisible();
    await agents.getByRole("button", { name: "Strong language" }).click();
    await expect(editorOf(page).locator('h2:text-is("Summary") + p')).toHaveText(SELECTION_REWRITE, { timeout: 60_000 });

    await caretIn(page, "Costs body words.");
    await expect(agents.getByText("Rewrites “Costs”.")).toBeVisible();
    await agents.getByRole("button", { name: "Simple language" }).click();
    await expect(editorOf(page).locator('h2:text-is("Costs") + p')).toContainText(SECTION_REWRITE, { timeout: 60_000 });

    await agents.getByRole("button", { name: "Close agents" }).click();
    await expect(panelRegion(page, "Agents")).toHaveCount(0);
    await expect(panelButton(page, "Agents")).toBeFocused();
  });

  test("“See all workflows” links to the workflows page for this document", async ({ page }) => {
    const id = await textDocument(page, "See all workflows");
    await openDocument(page, id);
    const agents = await openPanel(page, "Agents");
    await expect(agents.getByRole("link", { name: "See all workflows" })).toHaveAttribute("href", `/workflows?document=${id}`);
  });

  test("the workflow picker starts a built-in with no settings, shows its progress, and Open run shows the run", async ({ page, request }) => {
    const id = await createDocument(request, { title: uid("Workflow picker"), type_key: "general-report", content: [heading("Introduction"), para(), heading("Background"), para()] });
    await openDocument(page, id);
    const agents = await openPanel(page, "Agents");
    const picker = agents.getByRole("combobox", { name: "Select workflow" });
    await expect(picker.locator("optgroup")).not.toHaveCount(0);
    await expect(picker.locator('optgroup[label="General"]')).toHaveCount(1);
    await picker.selectOption({ label: "Draft all empty sections" });

    const progress = agents.getByRole("status").filter({ hasText: "Draft all empty sections" });
    await expect(progress).toBeVisible({ timeout: 30_000 });
    const open = progress.getByRole("button", { name: /^(Open run|Review)$/ });
    await expect(open).toBeVisible({ timeout: 90_000 });
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("tab", { name: "Workflows", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("heading", { name: "Draft all empty sections" })).toBeVisible();
  });
});

test.describe("the Sources pill", () => {
  test("opens the document modal on Sources, with the full library link at the top", async ({ page }) => {
    await openDocument(page, await textDocument(page, "Sources pill"));
    const dialog = await openModal(page, "Sources");
    await expect(dialog.getByRole("link", { name: "Open the full library" })).toHaveAttribute("href", "/library");
  });
});

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
    await page.waitForTimeout(500);
    await expect(helper).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(helper).toBeHidden();
    await page.keyboard.type("A second paragraph.");
    await expect(saveStatus(page)).toContainText("Saved");
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
    await expect(dog).toHaveCount(0);
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
    await expect(editorOf(page).locator("p", { hasText: DRAFTED })).toHaveCount(GENERAL_REPORT.length);
    await expect(page.locator("#doc-title")).toHaveValue("Stub report");

    await helper.getByRole("button", { name: "Done" }).click();
    await expect(helperOf(page)).toHaveCount(0);

    const dialog = await openModal(page, "Notes");
    await expect(dialog.getByRole("textbox", { name: "Notes" })).toHaveValue(new RegExp(prompt));
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await editorOf(page).locator("p").first().click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editorOf(page).locator("h2")).toHaveCount(0);
    await expect(editorOf(page)).toHaveText("");
  });

  test("the result card's Undo takes the drafts back", async ({ page }) => {
    await openNewDocument(page);
    const helper = helperOf(page);
    await helper.getByRole("button", { name: "tell me" }).click();
    await page.getByRole("textbox", { name: "What doc would you like to create?" }).fill(`A short report ${uid("undo")}`);
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(helper.getByText(/^Drafted \d+ of \d+ sections/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/from your request/)).toHaveCount(0);
    await helper.getByRole("button", { name: "Undo" }).click();
    await expect(helperOf(page)).toHaveCount(0);
    await expect(editorOf(page).locator("h2")).toHaveCount(0);
  });

  test("while “tell me” drafts, the Agents panel and the dividers can't change the document", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/documents/*/sections/*/generate", async (route) => {
      await gate;
      await route.continue();
    });
    await openNewDocument(page);
    await helperOf(page).getByRole("button", { name: "tell me" }).click();
    await page.getByRole("textbox", { name: "What doc would you like to create?" }).fill(`A report on the garden project ${uid("lock")}`);
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(helperOf(page).getByText(/^Drafting .*: 0 of \d+ sections$/)).toBeVisible({ timeout: 90_000 });

    for (const b of await editorOf(page).locator(".section-divider-btn").all()) await expect(b).toBeHidden();
    const agents = await openPanel(page, "Agents");
    await expect(agents.getByText("Sasha is drafting the document. Wait for it to finish or press Stop.")).toBeVisible();
    for (const chip of await agents.getByRole("group", { name: "Rewrite as…" }).getByRole("button").all()) await expect(chip).toHaveAttribute("aria-disabled", "true");

    release();
    await expect(helperOf(page).getByText(/^Drafted /)).toBeVisible({ timeout: 90_000 });
    await expect(agents.getByText("Sasha is drafting the document.")).toHaveCount(0);
  });
});

test.describe("the helper's layout", () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 1440, height: 900 },
  ]) {
    test(`stays clear of the panel buttons at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openNewDocument(page);
      const helper = helperOf(page);
      const tips = helper.locator("p");
      await expect(tips).toBeVisible();
      expect(intersects(await boxOf(tips), await boxOf(panelGroup(page)))).toBe(false);
      const tellMe = helper.getByRole("button", { name: "tell me" });
      await expectHittable(tellMe);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
});
