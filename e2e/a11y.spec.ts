// Axe scans of the main screens (phase9-spec.md §4.2), in both colour schemes
// (the light and dark projects in playwright.config.ts). Serious and critical
// violations fail; every violation is printed with its rule, impact, targets
// and help URL, and attached to the report as JSON. No rule is disabled.

import { createDocument, expect, expectNoA11yViolations, heading, openDocument, openModal, para, settle, test, text, uid } from "./fixtures";

const TABS = ["Notes", "Sources", "Data", "Suggestions", "Workflows"] as const;

async function sampleDocument(request: Parameters<typeof createDocument>[0]) {
  return createDocument(request, {
    title: uid("Axe sample"),
    content: [heading("Summary"), para(text("We ask for a replacement centrifuge because the current unit failed its safety inspection.")), heading("Costs"), para(text("Centrifuge 4,200 and installation 300, total 4,500."))],
  });
}

test.describe("axe", () => {
  test("editor: a new document", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.locator("#doc-title")).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "editor-new");
  });

  test("editor: a saved document with text", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    await expectNoA11yViolations(page, testInfo, "editor-saved");
  });

  test("editor: the documents panel open", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    await page.getByRole("button", { name: "Documents", exact: true }).click();
    await expect(page.locator("#docs-panel")).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "docs-panel");
  });

  for (const tab of TABS) {
    test(`document modal: ${tab} tab`, async ({ page, request }, testInfo) => {
      await openDocument(page, await sampleDocument(request));
      const dialog = await openModal(page);
      await dialog.getByRole("tab", { name: tab, exact: true }).click();
      await expect(dialog.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
      await settle(page);
      await expectNoA11yViolations(page, testInfo, `modal-${tab.toLowerCase()}`);
    });
  }

  test("learn review (stubbed learn.extract)", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    const dialog = await openModal(page);
    await dialog.getByRole("tab", { name: "Sources", exact: true }).click();
    await dialog.getByRole("button", { name: "Learn a type from these examples" }).click();
    const learn = page.getByRole("dialog", { name: /Learn a type from examples/ });
    await expect(learn).toBeVisible();
    await learn.getByRole("button", { name: /^Learn from/ }).click();
    await expect(learn.getByText("Check the draft against the examples.")).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "learn-review");
  });

  for (const path of ["/library", "/catalog", "/workflows", "/usage"]) {
    test(`page ${path}`, async ({ page }, testInfo) => {
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(400);
      await expect(page.locator("main").first()).toBeVisible();
      await settle(page);
      await expectNoA11yViolations(page, testInfo, `page${path.replace(/\//g, "-")}`);
    });
  }
});
