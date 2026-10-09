import { citation, createDocument, editorOf, expect, expectFocusVisible, openDocument, openNewDocument, para, saveStatus, test, text, uid, type Locator, type Page } from "./fixtures";

/** Presses Tab until `target` has focus (at most `max` presses), as a keyboard user would. */
async function tabTo(page: Page, target: Locator, { max = 60, back = false } = {}) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el: Element) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  await expect(target, `reached by ${back ? "Shift+Tab" : "Tab"} within ${max} presses`).toBeFocused();
}

const fab = (page: Page, name: string) => page.getByRole("group", { name: "Document panels" }).getByRole("button", { name, exact: true });

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
  // Beside the text (a wide window) Outline and Tools are toggles: Enter opens, Enter closes.
  for (const name of ["Outline", "Tools"]) {
    const button = fab(page, name);
    await tabTo(page, button);
    await expectFocusVisible(page, button);
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#editor-right-column")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expectFocusVisible(page, button);
  }

  // As a drawer over the text (a narrower window), Escape inside it closes it and puts focus back in the editor.
  await page.setViewportSize({ width: 1000, height: 800 });
  const outline = fab(page, "Outline");
  await tabTo(page, outline);
  await page.keyboard.press("Enter");
  const column = page.locator("#editor-right-column");
  await expect(column).toBeVisible();
  await tabTo(page, column, { max: 10, back: true });
  await expectFocusVisible(page);
  await page.keyboard.press("Escape");
  await expect(column).toBeHidden();
  await expect(outline).toHaveAttribute("aria-pressed", "false");
  await expect(editorOf(page)).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });

  const sources = fab(page, "Sources");
  await tabTo(page, sources);
  await expectFocusVisible(page, sources);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Sources" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectFocusVisible(page, page.locator('[role="group"][aria-label="Document panels"] button[title="Sources"]'));
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

test("keyboard only: the type gallery hands focus back to whichever control opened it", async ({ page }) => {
  await openNewDocument(page);
  const dialog = page.getByRole("dialog");

  // From the Outline panel's "Choose a type": that button is still on the page after Escape, so it gets focus back.
  const outline = fab(page, "Outline");
  await tabTo(page, outline);
  await page.keyboard.press("Enter");
  const choose = page.locator("#editor-right-column").getByRole("button", { name: "Choose a type" });
  await tabTo(page, choose);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(choose).toBeFocused();

  // From the header picker's menu item, which is gone once the menu closes: focus goes to the picker button.
  const picker = page.getByRole("button", { name: /^Document type:/ });
  await picker.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Browse all types…" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(picker).toBeFocused();
});
