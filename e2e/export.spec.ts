import { readFileSync } from "node:fs";
import { createDocument, expect, heading, openDocument, para, test, text, uid, type Page } from "./fixtures";

const PRINT_FALLBACK = "PDF rendering isn't available here";

async function exportAs(page: Page, item: string) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const menuItem = page.getByRole("menuitem", { name: item });
  await expect(menuItem).toBeVisible();
  const download = page.waitForEvent("download", { timeout: 90_000 });
  await menuItem.click();
  return download;
}

async function bytesOf(download: Awaited<ReturnType<typeof exportAs>>): Promise<Buffer> {
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
    const download = await exportAs(page, "Markdown (.md)");
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    const md = (await bytesOf(download)).toString("utf8");
    expect(md).toContain("Summary");
    expect(md).toContain("The export smoke test checks each format.");
  });

  test("Word downloads a .docx (a zip)", async ({ page }) => {
    const download = await exportAs(page, "Word (.docx)");
    expect(download.suggestedFilename()).toMatch(/\.docx$/);
    const bytes = await bytesOf(download);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  test("PDF downloads a PDF, or falls back to printing visibly", async ({ page }) => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const download = page.waitForEvent("download", { timeout: 90_000 }).then((d) => ({ kind: "download" as const, d }));
    const fallback = page.getByText(PRINT_FALLBACK).waitFor({ timeout: 90_000 }).then(() => ({ kind: "print" as const }));
    await page.getByRole("menuitem", { name: "PDF (.pdf)" }).click();
    const outcome = await Promise.race([download, fallback]);
    if (outcome.kind === "download") {
      expect(outcome.d.suggestedFilename()).toMatch(/\.pdf$/);
      const bytes = await bytesOf(outcome.d);
      expect(bytes.length).toBeGreaterThan(500);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    } else {
      // No Chrome for the server to render with: the menu said so and opened the print path instead.
      await expect(page.getByText(PRINT_FALLBACK)).toBeVisible();
    }
  });
});
