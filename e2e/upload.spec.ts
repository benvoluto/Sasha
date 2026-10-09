import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, routeBlobUploads, test, type Page } from "./fixtures";

type Blobs = Awaited<ReturnType<typeof routeBlobUploads>>;

const FIXTURES = path.join(__dirname, "fixtures");

/** Uploads one fixture under a unique name (the in-memory library outlives a test) and returns that name. */
async function upload(page: Page, blobs: Blobs, fixture: string, mimeType: string): Promise<string> {
  const [stem, ext] = fixture.split(".");
  const name = `${stem}-${Date.now().toString(36)}.${ext}`;
  const buffer = readFileSync(path.join(FIXTURES, fixture));
  blobs.register(name, buffer);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  return name;
}

/** Waits for the source's row to read Ready and its details (opened by the upload) to show its first table. */
async function expectReadyWithTable(page: Page, name: string, cell: string) {
  const row = page.getByRole("listitem").getByRole("button").filter({ hasText: name });
  await expect(row.getByText("Ready", { exact: true })).toBeVisible({ timeout: 60_000 });
  // A single upload opens its source's details.
  await expect(row).toHaveAttribute("aria-current", "true");
  const details = page.getByRole("complementary", { name: "Source details" });
  await expect(details.getByRole("heading", { name })).toBeVisible();
  const tables = details.getByRole("region", { name: /^Tables/ });
  await expect(tables.getByRole("heading", { name: "Tables (1)" })).toBeVisible({ timeout: 30_000 });
  // The list re-renders while the details refresh after reading; retry the expand until it holds.
  await expect(async () => {
    const toggle = tables.getByRole("listitem").getByRole("button", { expanded: false }).first();
    if (await toggle.isVisible()) await toggle.click({ timeout: 2_000 });
    await expect(tables.getByRole("table")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(tables.getByRole("cell", { name: cell, exact: true }).first()).toBeVisible();
}

let blobs: Blobs;

test.beforeEach(async ({ page }) => {
  blobs = await routeBlobUploads(page);
  await page.goto("/library");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("a CSV uploaded in the library is read and shows its table", async ({ page }) => {
  const name = await upload(page, blobs, "small.csv", "text/csv");
  await expectReadyWithTable(page, name, "Apples");
});

test("a one-page PDF uploaded in the library is read and shows its table", async ({ page }) => {
  // The text and the table come from the Gemini stubs (src/lib/e2e/stub-models.ts).
  const name = await upload(page, blobs, "small.pdf", "application/pdf");
  await expectReadyWithTable(page, name, "Pears");
});
