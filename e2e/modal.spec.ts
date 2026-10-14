import { createDocument, expect, openDocument, openModal, sourcesButton, test, uid } from "./fixtures";

const TABS = ["Notes", "Sources", "Data", "Suggestions", "Workflows"];

test("the Sources pill opens the document modal; each tab shows by click and by arrow keys; Escape returns focus to Sources", async ({ page, request }) => {
  const id = await createDocument(request, { title: uid("Modal smoke") });
  await openDocument(page, id);
  // Sources left the header for the right column's stack (redesign3-spec.md §13); Notes is the modal's first tab.
  await expect(page.locator("header").getByRole("button", { name: "Sources", exact: true })).toHaveCount(0);
  await expect(page.locator("header").getByRole("button", { name: "Notes", exact: true })).toHaveCount(0);
  await expect(sourcesButton(page)).toHaveAttribute("aria-haspopup", "dialog");
  const dialog = await openModal(page, "Sources");
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
  await expect(sourcesButton(page)).toBeFocused();

  // Notes through its tab: the field is there and takes text.
  const again = await openModal(page, "Notes");
  await expect(again.getByRole("textbox", { name: "Notes" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(again).toBeHidden();
  await expect(sourcesButton(page)).toBeFocused();
});
