import { createDocument, expect, openDocument, openModal, test, uid } from "./fixtures";

const TABS = ["Notes", "Sources", "Data", "Suggestions", "Workflows"];

test("the document modal shows each tab by click and by arrow keys; Escape returns focus to Notes", async ({ page, request }) => {
  const id = await createDocument(request, { title: uid("Modal smoke") });
  await openDocument(page, id);
  // By attribute: while the dialog is open Radix hides the page from the accessibility tree.
  const notes = page.locator('header button[aria-label="Notes"]');
  const dialog = await openModal(page);
  await expect(notes).toHaveAttribute("aria-expanded", "true");
  const tabs = dialog.getByRole("tablist");

  for (const name of TABS) {
    const tab = tabs.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("tabpanel")).toBeVisible();
  }

  // Back to the first tab with Home, then across with the arrows (Radix activates on focus).
  await tabs.getByRole("tab", { name: "Workflows" }).focus();
  await page.keyboard.press("Home");
  await expect(tabs.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
  for (const name of TABS.slice(1)) {
    await page.keyboard.press("ArrowRight");
    const tab = tabs.getByRole("tab", { name, exact: true });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: "Suggestions" })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(notes).toBeFocused();
  await expect(notes).toHaveAttribute("aria-expanded", "false");
});
