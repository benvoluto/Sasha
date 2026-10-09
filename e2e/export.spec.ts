import { readFileSync } from "node:fs";
import type { Download } from "@playwright/test";
import { createDocument, expect, heading, openDocument, openShareExport, para, test, text, uid, type Locator, type Page } from "./fixtures";

const PRINT_FALLBACK = "PDF rendering isn't available here";

/** Clicks one of the Share & Export dialog's format buttons and waits for the download; the dialog stays open after it. */
async function exportAs(page: Page, label: string): Promise<{ dialog: Locator; download: Download }> {
  const dialog = await openShareExport(page);
  const button = dialog.getByRole("button", { name: label, exact: true });
  await expect(button).toBeEnabled();
  const download = page.waitForEvent("download", { timeout: 90_000 });
  await button.click();
  return { dialog, download: await download };
}

/** The dialog's status line once a file is down: "Downloaded <filename>.". */
async function expectDownloaded(dialog: Locator, download: Download) {
  await expect(dialog.getByRole("status").filter({ hasText: /^Downloaded / })).toHaveText(`Downloaded ${download.suggestedFilename()}.`);
  await expect(dialog).toBeVisible();
}

async function bytesOf(download: Download): Promise<Buffer> {
  const file = await download.path();
  return readFileSync(file);
}

test.describe("export", () => {
  let id: string;

  test.beforeEach(async ({ page, request }) => {
    id = await createDocument(request, { title: uid("Export smoke"), content: [heading("Summary"), para(text("The export smoke test checks each format."))] });
    await openDocument(page, id);
  });

  test("Markdown downloads the document's text", async ({ page }) => {
    const { dialog, download } = await exportAs(page, "Markdown (.md)");
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    await expectDownloaded(dialog, download);
    const md = (await bytesOf(download)).toString("utf8");
    expect(md).toContain("Summary");
    expect(md).toContain("The export smoke test checks each format.");
  });

  test("Word downloads a .docx (a zip)", async ({ page }) => {
    const { dialog, download } = await exportAs(page, "Word (.docx)");
    expect(download.suggestedFilename()).toMatch(/\.docx$/);
    await expectDownloaded(dialog, download);
    const bytes = await bytesOf(download);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  test("PDF downloads a PDF, or falls back to printing visibly", async ({ page }) => {
    const dialog = await openShareExport(page);
    const download = page.waitForEvent("download", { timeout: 90_000 }).then((d) => ({ kind: "download" as const, d }));
    const fallback = page.getByText(PRINT_FALLBACK).waitFor({ timeout: 90_000 }).then(() => ({ kind: "print" as const }));
    await dialog.getByRole("button", { name: "PDF (.pdf)", exact: true }).click();
    const outcome = await Promise.race([download, fallback]);
    if (outcome.kind === "download") {
      expect(outcome.d.suggestedFilename()).toMatch(/\.pdf$/);
      const bytes = await bytesOf(outcome.d);
      expect(bytes.length).toBeGreaterThan(500);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
      await expectDownloaded(dialog, outcome.d);
    } else {
      // No Chrome for the server to render with: the dialog said so (through notify) and opened the print path instead.
      await expect(page.getByText(PRINT_FALLBACK)).toBeVisible();
    }
  });

  test("an export started from the keyboard keeps focus on its button", async ({ page }) => {
    const dialog = await openShareExport(page);
    const button = dialog.getByRole("button", { name: "Markdown (.md)", exact: true });
    await button.focus();
    const download = page.waitForEvent("download", { timeout: 90_000 });
    await page.keyboard.press("Enter");
    // While it runs the buttons are aria-disabled, never disabled, so the pressed one stays focused.
    await expect(button).toBeFocused();
    await expectDownloaded(dialog, await download);
    await expect(button).toBeFocused();
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
  });
});
