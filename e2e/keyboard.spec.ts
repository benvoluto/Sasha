import {
  citation,
  createDocument,
  createNote,
  editorOf,
  expect,
  expectFocusTrapped,
  expectFocusVisible,
  focusWithin,
  openDocument,
  openNewDocument,
  openOverview,
  overviewTabs,
  panelButton,
  panelRegion,
  para,
  saveStatus,
  sourcesButton,
  tabTo,
  test,
  text,
  uid,
} from "./fixtures";

test("keyboard only on the overview: skip link, the tablist's arrow keys, and Select mode's Escape", async ({ page, request }) => {
  await createDocument(request, { title: uid("Keyboard overview") });
  await openOverview(page);

  // The skip link is the page's first stop and lands on the main region.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expectFocusVisible(page, skip);
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  // One tab stop for the tablist (roving tabindex); the arrows move and select.
  const tabs = overviewTabs(page);
  const documents = tabs.getByRole("tab", { name: "Documents" });
  const notes = tabs.getByRole("tab", { name: "Notes" });
  await expect(documents).toHaveAttribute("aria-selected", "true");
  await expect(notes).toHaveAttribute("tabindex", "-1");
  await tabTo(page, documents, { back: true });
  await expectFocusVisible(page, documents);
  await page.keyboard.press("ArrowRight");
  await expect(notes).toBeFocused();
  await expect(notes).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible();
  await expect(page).toHaveURL(/[?&]tab=notes/);
  await page.keyboard.press("ArrowLeft");
  await expect(documents).toBeFocused();
  await expect(documents).toHaveAttribute("aria-selected", "true");
  for (const tab of [documents, notes]) {
    const panel = await tab.getAttribute("aria-controls");
    expect(panel, "each tab names its tabpanel").toBeTruthy();
  }

  // Select mode: Enter turns it on, Escape leaves and focus returns to Select.
  const select = page.getByRole("button", { name: "Select", exact: true });
  await tabTo(page, select);
  await page.keyboard.press("Enter");
  await expect(select).toHaveAttribute("aria-pressed", "true");
  const bar = page.getByRole("toolbar", { name: "Selected documents" });
  await expect(bar).toBeVisible();
  const box = page.getByRole("checkbox", { name: /^Select / }).first();
  await tabTo(page, box);
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  await expect(bar.getByText("1 selected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect(select).toHaveAttribute("aria-pressed", "false");
  await expectFocusVisible(page, select);
});

test("keyboard only in the editor: skip link, write a document, and open and close the panels", async ({ page }) => {
  await openNewDocument(page);

  // A new document opens with the caret in the editor, and it stays there once
  // the page has settled. The skip link is the page's first stop, so Shift+Tab
  // walks back to it past the header.
  await expect(editorOf(page)).toBeFocused();
  await page.waitForTimeout(1500);
  await expect(editorOf(page)).toBeFocused();
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await tabTo(page, skip, { max: 40, back: true });
  await expect(page.locator("body :is(a, button, input, select, [tabindex]:not([tabindex='-1']))").first()).toHaveText("Skip to main content");
  await expectFocusVisible(page, skip);
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  // Title, then on to the body.
  const title = page.locator("#doc-title");
  await tabTo(page, title);
  await expectFocusVisible(page, title);
  await page.keyboard.type(uid("Keyboard smoke"));
  await tabTo(page, editorOf(page));
  await page.keyboard.type("Typed without a mouse.");
  await expect(saveStatus(page)).toContainText("Saved");

  // Enter on a panel button opens its card with focus on the card's heading;
  // the card's close button puts the button back, focused.
  for (const name of ["Agents", "Outline"] as const) {
    const button = panelButton(page, name);
    await tabTo(page, button);
    await expectFocusVisible(page, button);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    const card = panelRegion(page, name);
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name, exact: true })).toBeFocused();
    const close = card.getByRole("button", { name: `Close ${name.toLowerCase()}`, exact: true });
    await tabTo(page, close, { max: 3 });
    await expectFocusVisible(page, close);
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    await expectFocusVisible(page, panelButton(page, name));
  }

  // As a drawer over the text (a narrower window), Escape closes it and focus returns to its button.
  await page.setViewportSize({ width: 1000, height: 800 });
  const outline = panelButton(page, "Outline");
  await tabTo(page, outline, { back: true });
  await page.keyboard.press("Enter");
  await expect(panelRegion(page, "Outline").getByRole("heading", { name: "Outline", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panelRegion(page, "Outline")).toHaveCount(0);
  await expect(panelButton(page, "Outline")).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });

  // The Sources pill opens the modal on its Sources tab, and Escape hands focus back.
  await tabTo(page, sourcesButton(page), { back: true });
  await expectFocusVisible(page, sourcesButton(page));
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Sources" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectFocusVisible(page, sourcesButton(page));
});

test("keyboard only: Alt+Enter in a cited sentence opens its source details; Escape closes them", async ({ page, request }) => {
  const id = await createDocument(request, { title: uid("Citation keys"), content: [para(text("Plain words first. "), text("A cited sentence.", [citation()]))] });
  await openDocument(page, id);

  const popover = page.getByRole("dialog", { name: "Source 1" });
  // Retried as a whole: on a cold server the page can still be settling (a late render can drop the caret).
  await expect(async () => {
    await tabTo(page, editorOf(page));
    // Into the cited words: to the end of the line, then back inside the citation.
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    // The caret hint's live region names the citation once the caret is in it.
    await expect(page.getByRole("status").filter({ hasText: /^Cited:/ })).toBeVisible({ timeout: 3_000 });
    await expect(editorOf(page)).toBeFocused({ timeout: 1_000 });
    await page.keyboard.press("Alt+Enter");
    await expect(popover).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  await expectFocusVisible(page);
  await expect(popover).toContainText(/./);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(editorOf(page)).toBeFocused();
});

test("keyboard only: the Outline's “See all document types” opens the Doc Gallery, which traps focus and returns it", async ({ page }) => {
  await openNewDocument(page);
  const outline = panelButton(page, "Outline");
  await tabTo(page, outline);
  await page.keyboard.press("Enter");
  const seeAll = panelRegion(page, "Outline").getByRole("button", { name: "See all document types" });
  await tabTo(page, seeAll, { max: 10 });
  await expectFocusVisible(page, seeAll);
  await page.keyboard.press("Enter");
  const gallery = page.getByRole("dialog", { name: "Doc Gallery" });
  await expect(gallery).toBeVisible();
  await expect.poll(() => focusWithin(gallery)).toBe(true);
  await expectFocusTrapped(page, gallery);
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden();
  await expectFocusVisible(page, seeAll);
});

test("keyboard only: the overview's Doc Gallery traps focus and returns it", async ({ page }) => {
  await openOverview(page);
  const button = page.getByRole("button", { name: "Doc Gallery" });
  await tabTo(page, button);
  await page.keyboard.press("Enter");
  const gallery = page.getByRole("dialog", { name: "Doc Gallery" });
  await expect(gallery).toBeVisible();
  await expectFocusTrapped(page, gallery);
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden();
  await expectFocusVisible(page, button);
});

test("keyboard only: the note dialog traps focus and returns it to its card", async ({ page, request }) => {
  const title = uid("Keyboard note");
  await createNote(request, `${title}\nA body to tab past.`);
  await openOverview(page, "/?tab=notes");
  const card = page.getByRole("tabpanel", { name: "Notes" }).getByRole("button", { name: title });
  await tabTo(page, card, { max: 200 });
  await expectFocusVisible(page, card);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Note" });
  await expect(dialog).toBeVisible();
  await expectFocusTrapped(page, dialog, 15);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectFocusVisible(page, card);
});
