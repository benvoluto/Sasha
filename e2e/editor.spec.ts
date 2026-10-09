import { editorOf, expect, openNewDocument, saveStatus, settle, test, uid } from "./fixtures";

test("a new document saves its title and body, survives a reload, and undoes typing", async ({ page }) => {
  await openNewDocument(page);
  const title = uid("Editor smoke");

  await page.locator("#doc-title").fill(title);
  const editor = editorOf(page);
  await editor.click();
  await page.keyboard.type("The first paragraph of the smoke test.");
  await expect(saveStatus(page)).toHaveText("Saved");
  // The first save gives the document an address.
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/);

  await page.reload();
  await expect(page.locator("#doc-title")).toHaveValue(title);
  await expect(editorOf(page)).toContainText("The first paragraph of the smoke test.");
  // A reload is a fresh load, like openDocument: let it settle before putting focus anywhere.
  await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
  await settle(page);

  // Undo takes back the last typing (and only that).
  await editorOf(page).click();
  await expect(editorOf(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Added later.");
  await expect(editorOf(page)).toBeFocused();
  await expect(editorOf(page)).toContainText("Added later.");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editorOf(page)).not.toContainText("Added later.");
  await expect(editorOf(page)).toContainText("The first paragraph of the smoke test.");
  await expect(saveStatus(page)).toHaveText("Saved");
});

test("on a phone the section actions button is a 44px touch target and the heading line keeps its height", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNewDocument(page);
  await editorOf(page).click();
  await page.keyboard.type("## Budget");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Body.");
  const gutter = page.locator(".section-gutter-inline").first();
  await expect(gutter).toBeVisible();
  const box = (await gutter.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  // The negative block margin keeps the heading on one line box of its usual height.
  const heading = (await editorOf(page).locator("h2").first().boundingBox())!;
  expect(heading.height).toBeLessThan(44);
});
