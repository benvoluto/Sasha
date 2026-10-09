import { cardSlot, citation, createDocument, editorOf, expect, expectFocusVisible, fab, headerButton, openDocument, openNewDocument, para, saveStatus, test, text, uid, type Locator, type Page } from "./fixtures";

/** Presses Tab until `target` has focus (at most `max` presses), as a keyboard user would. */
async function tabTo(page: Page, target: Locator, { max = 60, back = false } = {}) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el: Element) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  await expect(target, `reached by ${back ? "Shift+Tab" : "Tab"} within ${max} presses`).toBeFocused();
}

/** True when focus is on `target` or inside it. */
const focusWithin = (target: Locator) => target.evaluate((el: Element) => el === document.activeElement || el.contains(document.activeElement));

test("keyboard only: skip link, write a document, and open and close the floating panels", async ({ page }) => {
  await openNewDocument(page);

  // A new document opens with the caret in the editor, and it stays there once
  // the page has settled (the App Router's focus on the segment used to land on
  // <main> and take it). The skip link is the page's first stop, so Shift+Tab
  // walks back to it past the header and the rail. It shows on focus and lands
  // on the main region.
  await expect(editorOf(page)).toBeFocused();
  await page.waitForTimeout(1500);
  await expect(editorOf(page)).toBeFocused();
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await tabTo(page, skip, { max: 40, back: true });
  await expect(page.locator("body :is(a, button, input, [tabindex]:not([tabindex='-1']))").first()).toHaveText("Skip to main content");
  await expectFocusVisible(page, skip);
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  // Title, then on to the body.
  const title = page.locator("#doc-title");
  await tabTo(page, title);
  await expectFocusVisible(page, title);
  await page.keyboard.type(uid("Keyboard smoke"));
  await tabTo(page, editorOf(page));
  await page.keyboard.type("Typed without a mouse.");
  await expect(saveStatus(page)).toHaveText("Saved");

  // The floating buttons follow the editor in tab order (ProseMirror doesn't trap Tab).
  // The group holds only Outline and Tools (Sources moved to the header), and they
  // only open: a button hides while its card shows, so neither is a toggle.
  const group = page.getByRole("group", { name: "Document panels" });
  await expect(group.getByRole("button")).toHaveText(["Outline", "Tools"]);
  for (const name of ["Outline", "Tools"] as const) await expect(fab(page, name)).not.toHaveAttribute("aria-pressed");

  // Enter opens the card and moves focus into its slot; the next Tab reaches the
  // card's close button, and closing it brings the button back with focus on it.
  for (const name of ["Outline", "Tools"] as const) {
    const button = fab(page, name);
    await tabTo(page, button);
    await expectFocusVisible(page, button);
    await page.keyboard.press("Enter");
    await expect(button).toHaveCount(0);
    const slot = cardSlot(page, name);
    await expect(page.locator("#editor-right-column")).toBeVisible();
    await expect.poll(() => focusWithin(slot)).toBe(true);
    const close = slot.getByRole("button", { name: `Close ${name.toLowerCase()}`, exact: true });
    await tabTo(page, close, { max: 3 });
    await expectFocusVisible(page, close);
    await page.keyboard.press("Enter");
    await expect(slot).toHaveCount(0);
    await expectFocusVisible(page, button);
  }

  // As a drawer over the text (a narrower window), Escape inside it closes it and both buttons come back.
  await page.setViewportSize({ width: 1000, height: 800 });
  const outline = fab(page, "Outline");
  await tabTo(page, outline);
  await page.keyboard.press("Enter");
  const column = page.locator("#editor-right-column");
  await expect(column).toBeVisible();
  await expect.poll(() => focusWithin(cardSlot(page, "Outline"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(column).toBeHidden();
  await expect(fab(page, "Outline")).toBeVisible();
  await expect(fab(page, "Tools")).toBeVisible();
  // Focus lands somewhere useful: back in the editor, or on the Outline button.
  await expect.poll(async () => (await focusWithin(editorOf(page))) || (await focusWithin(fab(page, "Outline")))).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Sources lives in the header now; the modal opens on its Sources tab and Escape hands focus back.
  const sources = page.locator("header").getByRole("button", { name: "Sources", exact: true });
  await tabTo(page, sources, { back: true });
  await expectFocusVisible(page, sources);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Sources" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectFocusVisible(page, headerButton(page, "Sources"));
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

test("keyboard only: the Document Gallery hands focus back to whichever control opened it", async ({ page }) => {
  await openNewDocument(page);
  const gallery = page.getByRole("dialog", { name: "Document Gallery" });

  // From the header button (its name gains ", suggestion ready" while the classifier has one).
  const button = page.locator("header").getByRole("button", { name: /^Document Gallery/ });
  await tabTo(page, button, { back: true });
  await expectFocusVisible(page, button);
  await page.keyboard.press("Enter");
  await expect(gallery).toBeVisible();
  await expect(headerButton(page, "Document Gallery")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden();
  await expectFocusVisible(page, headerButton(page, "Document Gallery"));

  // From the Outline card's "Choose a type": that button is still on the page after Escape, so it gets focus back.
  const outline = fab(page, "Outline");
  await tabTo(page, outline);
  await page.keyboard.press("Enter");
  const choose = cardSlot(page, "Outline").getByRole("button", { name: "Choose a type" });
  await tabTo(page, choose, { max: 10 });
  await page.keyboard.press("Enter");
  await expect(gallery).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden();
  await expect(choose).toBeFocused();
});
