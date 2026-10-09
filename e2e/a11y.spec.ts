// Axe scans of the main screens (phase9-spec.md §4.2), in both colour schemes
// (the light and dark projects in playwright.config.ts). Serious and critical
// violations fail; every violation is printed with its rule, impact, targets
// and help URL, and attached to the report as JSON. No rule is disabled.
// Redesign 2 (redesign2-spec.md §7) adds the header's dialogs, the olive Tools
// and Outline cards, and the empty document's helper and "tell me" flow.

import { createDocument, expect, expectNoA11yViolations, heading, helperOf, openCard, openDocument, openGallery, openModal, openNewDocument, openShareExport, para, settle, test, text, uid } from "./fixtures";

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

  test("Document Gallery: an untyped document", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    const gallery = await openGallery(page);
    await expect(gallery.getByText(/No type yet/)).toBeVisible();
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "gallery-untyped");
  });

  test("Document Gallery: a typed document", async ({ page, request }, testInfo) => {
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

  test("Tools and Outline cards open beside the text", async ({ page, request }, testInfo) => {
    await openDocument(page, await sampleDocument(request));
    // The caret in a section, so the Tools card's chips are enabled and the outline has a current row.
    await page.locator('.ProseMirror[aria-label="Document"] p').first().click();
    await openCard(page, "Tools");
    await openCard(page, "Outline");
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "cards-inline");
  });

  test("Tools and Outline cards in the phone sheet", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDocument(page, await sampleDocument(request));
    await openCard(page, "Outline");
    await openCard(page, "Tools");
    await settle(page);
    await expectNoA11yViolations(page, testInfo, "cards-sheet");
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
